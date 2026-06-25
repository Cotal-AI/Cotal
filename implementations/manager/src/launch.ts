import { readFileSync, writeFileSync, lstatSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { assertValidChannel, assertValidName, ensureDirNoSymlink, isConcreteChannel, realDirNoSymlink, type MeshLaunchAgent, type MeshLaunchSpec } from "@cotal-ai/core";

/**
 * Load + materialize a resolved launch spec for `supervise --launch`.
 *
 * The CLI's manifest resolver produces the spec (`cotal-launch/v1`); the manager treats it as
 * **untrusted input** — strict schema, path-safe run id + agent names — then materializes each
 * agent's persona to a **transient, non-authoritative** file under `.cotal/run/<runId>/agents/`
 * (never `.cotal/agents/`, never persona-discoverable). Creds are minted from the spec's `policy`,
 * not from this file, so the file carries no ACL/capability frontmatter.
 */

// A NATS-/path-safe token: connector type, role (a route token), capability, run id. Keeps a
// hand-edited/malicious launch spec from feeding rewritten route/capability strings into the manager
// path (channel policies are re-validated at provision time; these complete the untrusted contract).
const TOKEN = /^[A-Za-z0-9_-]+$/;
const RunId = z.string().regex(TOKEN, "runId must be a path-safe token ([A-Za-z0-9_-])");

const LaunchAgentSchema = z.strictObject({
  name: z.string().min(1),
  agent: z.string().regex(TOKEN, "agent must be a connector token ([A-Za-z0-9_-])"),
  role: z.string().regex(TOKEN, "role must be a route-safe token ([A-Za-z0-9_-])").optional(),
  model: z.string().optional(),
  description: z.string().optional(),
  body: z.string().optional(),
  capabilities: z.array(z.string().regex(TOKEN, "capability must be a safe token ([A-Za-z0-9_-])")).optional(),
  subscribe: z.array(z.string()),
  allowSubscribe: z.array(z.string()),
  allowPublish: z.array(z.string()),
  personaPath: z.string().optional(),
  hash: z.string().regex(/^[A-Za-z0-9]+$/, "hash must be alphanumeric"),
});

const LaunchSpecSchema = z.strictObject({
  apiVersion: z.literal("cotal-launch/v1"),
  space: z.string().min(1),
  runId: RunId,
  agents: z.array(LaunchAgentSchema),
});

/** Parse + strictly validate a launch spec file. Throws on any deviation (it's untrusted, local
 *  though it is) — including an agent name that isn't a safe mesh/file token (no path traversal). */
export function loadLaunchSpec(path: string): MeshLaunchSpec {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`launch spec ${path}: ${(e as Error).message}`);
  }
  const r = LaunchSpecSchema.safeParse(json);
  if (!r.success)
    throw new Error(`launch spec ${path}: ${r.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ")}`);
  for (const a of r.data.agents) {
    assertValidName(a.name); // names the transient file → must be safe
    validateLaunchPolicy(a); // don't let --launch be a looser second manifest format
  }
  return r.data;
}

/** Resolve + load the launch spec for a run id, deriving the path from a known root rather than
 *  accepting one. The `launch` control op (`spawn -f` onto a running manager) passes a `runId`, NOT a
 *  path — so a (admin-only) caller can never make the manager read an arbitrary host-local JSON: the
 *  id must be a safe token, `.cotal/run` must be a real (non-symlink) dir chain, and the spec file
 *  itself must not be a symlink. Then the usual untrusted-input validation ({@link loadLaunchSpec})
 *  applies, and the spec's self-declared `runId` must match the requested one. */
export function launchSpecForRun(root: string, runId: string): MeshLaunchSpec {
  if (!TOKEN.test(runId)) throw new Error(`unsafe runId ${JSON.stringify(runId)} (allowed: letters, digits, _ -)`);
  const runDir = realDirNoSymlink(root, ".cotal", "run"); // refuse a symlinked .cotal / run parent
  if (!runDir) throw new Error(`no launch spec for run ${runId} (.cotal/run is absent)`);
  const path = join(runDir, `${runId}.json`);
  let st;
  try {
    st = lstatSync(path);
  } catch {
    throw new Error(`no launch spec for run ${runId} at ${path}`);
  }
  if (st.isSymbolicLink()) throw new Error(`refusing to read launch spec "${path}": it is a symlink`);
  const spec = loadLaunchSpec(path);
  if (spec.runId !== runId) throw new Error(`launch spec runId "${spec.runId}" does not match requested "${runId}"`);
  return spec;
}

// Capabilities that actually grant anything in v1 (provisionAgent only acts on `spawn`); an unknown
// capability is inert downstream, so reject it at the boundary rather than carry a no-op grant.
const KNOWN_CAPABILITIES = new Set(["spawn"]);

/** Re-enforce the v1 manifest's policy constraints at the manager boundary so a hand-edited/malicious
 *  launch spec can't smuggle in what the CLI schema would reject: concrete channels only (no wildcard
 *  scopes — the v1 wildcard deferral), `subscribe ⊆ allowSubscribe`, and known capabilities. Channel
 *  policies are re-checked again at provision time, but this fails BEFORE any provisioning side effect. */
function validateLaunchPolicy(a: MeshLaunchAgent): void {
  const where = `launch agent "${a.name}"`;
  for (const [field, list] of [["subscribe", a.subscribe], ["allowSubscribe", a.allowSubscribe], ["allowPublish", a.allowPublish]] as const)
    for (const ch of list) {
      try {
        assertValidChannel(ch);
      } catch (e) {
        throw new Error(`${where}: ${field}: ${(e as Error).message}`);
      }
      if (!isConcreteChannel(ch)) throw new Error(`${where}: ${field} "${ch}" is a wildcard — not allowed in a v1 launch spec`);
    }
  const missing = a.subscribe.filter((c) => !a.allowSubscribe.includes(c));
  if (missing.length) throw new Error(`${where}: subscribe [${missing.join(", ")}] not within allowSubscribe`);
  for (const cap of a.capabilities ?? [])
    if (!KNOWN_CAPABILITIES.has(cap)) throw new Error(`${where}: unknown capability "${cap}" (known: ${[...KNOWN_CAPABILITIES].join(", ")})`);
}

/** Materialize one resolved agent's persona to a transient file the connector reads, and return its
 *  path. Carries only what a connector needs (identity/role/model/description + body) plus a loud
 *  generated-artifact header — never ACL/capability frontmatter (creds come from the spec's policy). */
export function materializePersona(root: string, runId: string, a: MeshLaunchAgent): string {
  // 0700 dirs created component-by-component, refusing a symlinked parent (writes can't escape the
  // run tree); plus a lexical direct-child check on the final path as belt-and-suspenders.
  const dir = ensureDirNoSymlink(root, ".cotal", "run", runId, "agents");
  const path = resolve(dir, `${a.name}.md`);
  if (dirname(path) !== dir) throw new Error(`unsafe agent name "${a.name}" — persona path escapes ${dir}`);
  const fm = ["---", `name: ${a.name}`];
  if (a.role) fm.push(`role: ${scalar(a.role)}`);
  if (a.model) fm.push(`model: ${scalar(a.model)}`);
  if (a.description) fm.push(`description: ${scalar(a.description)}`);
  fm.push("---", "");
  const src = a.personaPath ?? "the manifest";
  const header = `<!-- Generated runtime artifact from a cotal mesh manifest (run ${runId}). Do NOT edit — regenerated on each launch and deleted by \`cotal down\`. Edit ${src} instead. This file is not a reusable persona and carries no access authority. -->`;
  const body = a.body ? `${a.body.trim()}\n` : "";
  // `wx`: exclusive create — fails rather than following a symlink pre-planted at the path.
  writeFileSync(path, `${fm.join("\n")}${header}\n\n${body}`, { mode: 0o600, flag: "wx" });
  return path;
}

/** Build the manager spawn opts for a launch agent: identity/role/model + the resolved object
 *  (which carries the ACL authority) + the materialized configPath. */
export function launchAgentToStartOpts(a: MeshLaunchAgent, configPath: string): {
  name: string;
  agent: string;
  role?: string;
  model?: string;
  config: string;
  resolved: MeshLaunchAgent;
} {
  return { name: a.name, agent: a.agent, role: a.role, model: a.model, config: configPath, resolved: a };
}

/** Quote a frontmatter scalar so the agent-file parser reads it back unchanged (it strips a matching
 *  outer quote pair). Plain tokens pass through; anything with structural chars is double-quoted. */
function scalar(v: string): string {
  if (v === v.trim() && !/^\[/.test(v) && !/[:#"'\r\n]/.test(v)) return v;
  if (!v.includes('"') && !/[\r\n]/.test(v)) return `"${v}"`;
  return JSON.stringify(v.replace(/[\r\n]+/g, " "));
}
