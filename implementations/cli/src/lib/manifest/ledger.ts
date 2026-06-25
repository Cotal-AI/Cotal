/**
 * The `spawn -f` ownership ledger (`cotal-ledger/v1`, one file per run at
 * `.cotal/manifests/<runId>.json`): the durable, creation-only record of exactly what a `spawn -f`
 * deploy added to a shared mesh — the registry keys it created and the agents it spawned (by the
 * manager-reply **spawned** name + nkey id). `down -f` reads it to tear down *only* those resources.
 *
 * Two hard rules, because a tampered ledger could otherwise become arbitrary process/credential/file
 * deletion (the round-8/9 security review):
 *   1. **Store IDs, never arbitrary paths.** Cred paths are *derived* from the known auth root at
 *      teardown ({@link ownedCredPath}); the run dir is `.cotal/run/<runId>`. The ledger never names
 *      a path to delete.
 *   2. **Treat the file as untrusted on read.** {@link loadLedger} strictly validates the whole
 *      ledger (schema, token-safe ids/names, concrete channels, duplicate detection) BEFORE the
 *      caller takes any destructive action — fail closed, globally.
 */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, renameSync, lstatSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { z } from "zod";
import { assertValidChannel, assertValidName, ensureDirNoSymlink, isConcreteChannel, realDirNoSymlink } from "@cotal-ai/core";
import { authDir } from "@cotal-ai/workspace";

export const LEDGER_VERSION = "cotal-ledger/v1";

// Path-/route-safe token (run id, agent name) and an alphanumeric content hash — same shapes the
// launch spec uses, so the ledger can't smuggle a traversal/injection string into a derived path.
const TOKEN = /^[A-Za-z0-9_-]+$/;
const HASH = /^[A-Za-z0-9]+$/;

const LedgerAgentSchema = z.strictObject({
  /** The manifest agent key (`agents:` name) — display + the stable key a re-apply matches a declared
   *  agent against (the spawned name may collision-number, so it can't be that key). */
  requested: z.string().regex(TOKEN, "requested name must be a path-safe token ([A-Za-z0-9_-])"),
  /** The manager-reply SPAWNED name (collision-numbered, e.g. `socrates-2`) — what creds are filed
   *  under; the cred path derives from THIS, never the manifest key. */
  name: z.string().regex(TOKEN, "agent name must be a path-safe token ([A-Za-z0-9_-])"),
  /** The spawned agent's nkey id — the immutable identity `down -f` matches before stopping. */
  id: z.string().min(1),
  /** The resolved hash at spawn (drift/stale detection on re-apply). */
  hash: z.string().regex(HASH, "hash must be alphanumeric"),
});

const LedgerSchema = z.strictObject({
  apiVersion: z.literal(LEDGER_VERSION),
  kind: z.literal("MeshLedger"),
  runId: z.string().regex(TOKEN, "runId must be a path-safe token ([A-Za-z0-9_-])"),
  space: z.string().min(1),
  server: z.string().min(1),
  /** Content hash of the source manifest — an INDEX for `down -f cotal.yaml` only, never authority. */
  manifestHash: z.string().regex(HASH, "manifestHash must be alphanumeric"),
  /** The source manifest path — operator/display context only; never derived from or deleted. */
  manifestPath: z.string().min(1),
  teardownMode: z.literal("ledger-scoped"),
  created: z.strictObject({
    /** Registry keys this run CREATED (brand-new only — never adopted/pre-existing). */
    channels: z.array(z.string()),
    agents: z.array(LedgerAgentSchema),
  }),
});

export type MeshLedger = z.infer<typeof LedgerSchema>;
export type LedgerAgent = z.infer<typeof LedgerAgentSchema>;

/** Assemble a ledger from a `spawn -f` apply result. `agents` carry the manager-reply SPAWNED name
 *  (cred-keying) + manifest `requested` key + nkey id + resolved hash; `channels` are the brand-new
 *  registry keys this run created. */
export function buildLedger(opts: {
  runId: string;
  space: string;
  server: string;
  manifestHash: string;
  manifestPath: string;
  channels: string[];
  agents: LedgerAgent[];
}): MeshLedger {
  return {
    apiVersion: LEDGER_VERSION,
    kind: "MeshLedger",
    runId: opts.runId,
    space: opts.space,
    server: opts.server,
    manifestHash: opts.manifestHash,
    manifestPath: opts.manifestPath,
    teardownMode: "ledger-scoped",
    created: { channels: opts.channels, agents: opts.agents },
  };
}

/** Stable index hash of the manifest source text — ties a `down -f cotal.yaml` back to its ledger
 *  (an edited file no longer matches, so `down -f` fails rather than guessing; `--run` is the
 *  escape hatch). NOT an integrity check and NOT ownership authority — only a lookup key. */
export function hashManifestSource(src: string): string {
  return createHash("sha256").update(src).digest("hex").slice(0, 16);
}

/** Write the ledger to `<root>/.cotal/manifests/<runId>.json`, `0600`, atomically and refusing a
 *  symlinked parent. A brand-new ledger is `wx` (exclusive create); an additive update (re-apply)
 *  goes temp-then-rename so `down -f` never reads a half-written file. */
export function writeLedger(root: string, ledger: MeshLedger, opts: { update?: boolean } = {}): string {
  const dir = ensureDirNoSymlink(root, ".cotal", "manifests");
  const path = join(dir, `${ledger.runId}.json`);
  const body = JSON.stringify(ledger, null, 2);
  if (opts.update) {
    // Atomic replace: write a fresh temp (exclusive — never follow a pre-planted symlink), then
    // rename over the target. `rename` replaces the destination name itself, not a symlink target.
    const tmp = join(dir, `.${ledger.runId}.${randomBytes(4).toString("hex")}.tmp`);
    writeFileSync(tmp, body, { mode: 0o600, flag: "wx" });
    renameSync(tmp, path);
  } else {
    writeFileSync(path, body, { mode: 0o600, flag: "wx" });
  }
  return path;
}

/** Parse + strictly validate a ledger file as **untrusted input** — schema, unknown-key rejection,
 *  token-safe run id / agent names, concrete channel keys, and duplicate detection — so the WHOLE
 *  ledger is proven before the caller deletes anything (no partial "validated the class I'm about to
 *  delete" flow). Throws on any deviation. */
export function loadLedger(path: string): MeshLedger {
  // No-follow: the ledger drives destructive teardown, so refuse a symlinked ledger file (a symlink
  // could redirect `down -f` to attacker-chosen content). Callers also prove the parent dir chain.
  let st;
  try {
    st = lstatSync(path);
  } catch (e) {
    throw new Error(`ledger ${path}: ${(e as Error).message}`);
  }
  if (st.isSymbolicLink()) throw new Error(`refusing to read ledger "${path}": it is a symlink`);
  if (!st.isFile()) throw new Error(`refusing to read ledger "${path}": not a regular file`);
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`ledger ${path}: ${(e as Error).message}`);
  }
  const r = LedgerSchema.safeParse(json);
  if (!r.success)
    throw new Error(`ledger ${path}: ${r.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ")}`);
  const led = r.data;
  const agents = new Set<string>();
  for (const a of led.created.agents) {
    assertValidName(a.name); // belt-and-suspenders past the regex — it names a derived cred path
    if (agents.has(a.name)) throw new Error(`ledger ${path}: duplicate owned agent "${a.name}"`);
    agents.add(a.name);
  }
  const channels = new Set<string>();
  for (const ch of led.created.channels) {
    assertValidChannel(ch);
    if (!isConcreteChannel(ch)) throw new Error(`ledger ${path}: owned channel "${ch}" is not concrete`);
    if (channels.has(ch)) throw new Error(`ledger ${path}: duplicate owned channel "${ch}"`);
    channels.add(ch);
  }
  return led;
}

/** Every valid ledger under `<root>/.cotal/manifests/`. Unparseable/foreign files are skipped (a
 *  targeted `down -f --run <id>` names one directly); used to resolve a `down -f cotal.yaml` to its
 *  run by `manifestHash`. */
export function listLedgers(root: string): Array<{ path: string; ledger: MeshLedger }> {
  // Prove `.cotal/manifests` is a real (non-symlink) directory chain before reading under it — a
  // symlinked parent could redirect `down -f` to attacker-chosen ledgers.
  const dir = realDirNoSymlink(root, ".cotal", "manifests");
  if (!dir) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: Array<{ path: string; ledger: MeshLedger }> = [];
  for (const n of names) {
    if (!n.endsWith(".json") || n.startsWith(".")) continue;
    const p = join(dir, n);
    try {
      const ledger = loadLedger(p);
      if (`${ledger.runId}.json` !== n) continue; // filename must match the declared runId (no spoofed authority)
      out.push({ path: p, ledger });
    } catch {
      /* skip — a foreign/corrupt file isn't this run's ledger; `--run` targets a known one */
    }
  }
  return out;
}

/** Resolve a `down -f cotal.yaml` to its ledger by the manifest's content hash. Fails (never
 *  guesses) when nothing matches (edited file) or more than one does — `--run <id>` is the escape. */
export function findLedgerByHash(root: string, manifestHash: string): { path: string; ledger: MeshLedger } {
  const matches = listLedgers(root).filter((l) => l.ledger.manifestHash === manifestHash);
  if (matches.length === 0)
    throw new Error(`no ledger matches this manifest's current contents (was it edited since \`spawn -f\`?) — tear down by run id: \`cotal down -f <file> --run <id>\``);
  if (matches.length > 1)
    throw new Error(`${matches.length} runs share this manifest — name one: ${matches.map((m) => m.ledger.runId).join(", ")} (\`--run <id>\`)`);
  return matches[0];
}

/** Resolve a ledger by explicit run id (the `--run <id>` path). Validates the id is a safe token
 *  before deriving the path. */
export function findLedgerByRun(root: string, runId: string): { path: string; ledger: MeshLedger } {
  assertValidName(runId);
  const dir = realDirNoSymlink(root, ".cotal", "manifests"); // refuse a symlinked manifests parent
  if (!dir) throw new Error(`no ledger for run ${runId} (.cotal/manifests is absent)`);
  const path = join(dir, `${runId}.json`);
  const ledger = loadLedger(path); // loadLedger refuses a symlinked ledger file
  // Bind the filename to the contents: a tampered `<runId>.json` whose body declares a DIFFERENT
  // runId must not redirect teardown to that other run's derived run dir / resources.
  if (ledger.runId !== runId) throw new Error(`ledger ${path}: declares runId "${ledger.runId}", not "${runId}" — refusing`);
  return { path, ledger };
}

/** Derive an owned agent's cred path under the known auth root — `<root>/.cotal/auth/creds/<name>.creds`
 *  — from the SPAWNED name, rejecting any name that escapes the creds dir. The ledger never stores a
 *  cred path; teardown derives it here and the caller deletes it no-follow ({@link unlinkFileNoFollow}). */
export function ownedCredPath(root: string, spawnedName: string): string {
  assertValidName(spawnedName);
  const dir = resolve(authDir(root), "creds");
  const path = resolve(dir, `${spawnedName}.creds`);
  if (dirname(path) !== dir) throw new Error(`unsafe owned agent name "${spawnedName}" — cred path escapes ${dir}`);
  return path;
}
