/**
 * Agent definition files — the persisted form of an agent's identity + persona.
 *
 *   .cotal/agents/<name>.md
 *   ---
 *   name: builder              # AgentCard-shaped identity in the frontmatter
 *   role: builder
 *   description: …
 *   tags: [edit, test]
 *   subscribe: [general]       # channels this agent actively reads at boot (the live set)
 *   allowSubscribe: [general]  # read ACL — channels it MAY read; omit ⇒ same as `subscribe`
 *   allowPublish: [general]    # post ACL — channels it may publish to; omit ⇒ DENY (default-deny)
 *   model: opus                # optional CLI/model override
 *   capabilities: [spawn]  # control-plane capabilities (spawn → may start/despawn others)
 *   face: sven             # any unmodelled key is kept verbatim in AgentDef.meta — e.g. the
 *                          #   OpenCode connector reads meta.face for its avatar viewer
 *   ---
 *   <the Markdown body is the persona — an appended system prompt>
 *
 * A launcher resolves a name (or path) to one of these, hands the persona/model
 * to the agent process at spawn, and passes the file through so the joined
 * session reads its own card from it. Part of the wire contract's onboarding
 * half, alongside the join link.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { EndpointKind } from "./types.js";
import { assertValidName } from "./resolve.js";
import { assertValidChannel, channelInAllow } from "./subjects.js";

export interface AgentDef {
  name: string;
  role?: string;
  kind?: EndpointKind;
  description?: string;
  tags?: string[];
  /** The *active* read set: channels this agent subscribes to at boot (the live chat-durable
   *  filter; mutable at runtime via join/leave). Must be ⊆ {@link allowSubscribe}. Default `[general]`. */
  subscribe?: string[];
  /** The read **ACL**: channels this agent *may* read (auth mode → minted as per-channel
   *  history-consumer create grants; the live durable's filter is also held within it). Entries
   *  may be wildcard subtrees (`team.>`). Omitted ⇒ defaults to {@link subscribe} — it can read
   *  exactly what it subscribes to. */
  allowSubscribe?: string[];
  /** The post **ACL**: channels this agent may publish to (auth mode → minted into pub-allow
   *  ACLs). Entries may be wildcard subtrees (`team.>`). Omitted ⇒ **deny** (default-deny):
   *  publishing is the dangerous capability, so it must be declared explicitly. */
  allowPublish?: string[];
  /** Model override handed to the agent CLI (e.g. `claude --model`). */
  model?: string;
  /** Capabilities this agent may exercise on the control plane (auth mode → minted into the
   *  cred's publish allow-list). Today `spawn` is the only one: it grants publish to the
   *  privileged control subject (start/purge/definePersona/named stop). Default-deny when
   *  absent — nats-server, not a handler, is the boundary. Granting authority is operator-level
   *  (`definePersona` is itself privileged), so no peer can self-grant via its own agent file. */
  capabilities?: string[];
  /** Authenticated id of the agent that first defined this persona via `definePersona` (P6). A
   *  POLICY field, not content: the privileged tier may *redefine* an existing file only if its
   *  `owner` equals the caller; everyone else needs the admin tier. Fail-closed — an ownerless
   *  file (legacy / operator-written) is admin-only, and a caller can never claim ownership of an
   *  existing file. Set once at creation (owner = creator), preserved on every later redefine. */
  owner?: string;
  /** Frontmatter keys not modelled above, kept verbatim so a connector can read its own launcher
   *  hints without core knowing about each one (e.g. the OpenCode face viewer's `face:` avatar id). */
  meta?: Record<string, string>;
  /** Markdown body — the agent's persona / appended system prompt. */
  persona?: string;
}

/** Strip wrapping quotes from a scalar value. */
function unquote(v: string): string {
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
    return v.slice(1, -1);
  return v;
}

/** Parse the frontmatter subset we support: `key: value` scalars and inline
 *  `key: [a, b]` string lists. Throws on anything fancier — block lists, nested
 *  maps and multi-doc YAML are deliberately unsupported (no silent fallback). */
function parseFrontmatter(src: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const raw of src.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon < 1) throw new Error(`agent file: unparseable frontmatter line "${raw}"`);
    const key = line.slice(0, colon).trim();
    const val = line.slice(colon + 1).trim();
    if (val.startsWith("[")) {
      if (!val.endsWith("]")) throw new Error(`agent file: unterminated list for "${key}"`);
      out[key] = val
        .slice(1, -1)
        .split(",")
        .map((s) => unquote(s.trim()))
        .filter(Boolean);
    } else {
      out[key] = unquote(val);
    }
  }
  return out;
}

/** Load and parse an agent definition file (Markdown + `---` frontmatter). */
export function loadAgentFile(path: string): AgentDef {
  const src = readFileSync(path, "utf8");
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(src);
  if (!m) throw new Error(`agent file ${path}: missing "---" frontmatter block`);
  const fm = parseFrontmatter(m[1]);
  const persona = m[2].trim();

  const str = (k: string): string | undefined => {
    const v = fm[k];
    if (Array.isArray(v)) throw new Error(`agent file ${path}: "${k}" must be a scalar`);
    return v;
  };
  const list = (k: string): string[] | undefined => {
    const v = fm[k];
    if (v === undefined) return undefined;
    return Array.isArray(v) ? v : [v];
  };

  const name = str("name");
  if (!name) throw new Error(`agent file ${path}: "name" is required`);
  assertValidName(name);
  const kind = str("kind");
  if (kind && kind !== "agent" && kind !== "endpoint")
    throw new Error(`agent file ${path}: "kind" must be "agent" or "endpoint"`);

  // The pre-ACL field names were renamed (channels→subscribe, publish→allowPublish, +allowSubscribe).
  // Fail loud on the old names rather than silently sweeping them into meta and ignoring them —
  // an unmigrated file would otherwise lose its read/post scope without warning (no silent degrade).
  for (const old of ["channels", "publish"])
    if (old in fm)
      throw new Error(
        `agent file ${path}: "${old}" was renamed — use "subscribe"/"allowSubscribe" (read) and "allowPublish" (post)`,
      );

  const subscribe = list("subscribe");
  const allowSubscribe = list("allowSubscribe");
  const allowPublish = list("allowPublish");
  // Reject channel names the wire layer would silently rewrite — a policy name must equal its wire
  // token, or the ACL aliases (see assertValidChannel). Covers all three scope fields.
  for (const ch of [...(subscribe ?? []), ...(allowSubscribe ?? []), ...(allowPublish ?? [])])
    try {
      assertValidChannel(ch);
    } catch (e) {
      throw new Error(`agent file ${path}: ${(e as Error).message}`);
    }
  // Invariant (fail-loud at load): the active read set must be within the read ACL. Defaults:
  // subscribe ⇒ [general]; allowSubscribe ⇒ subscribe (read exactly what you subscribe to).
  const effSubscribe = subscribe?.length ? subscribe : ["general"];
  const effAllow = allowSubscribe?.length ? allowSubscribe : effSubscribe;
  for (const ch of effSubscribe)
    if (!channelInAllow(effAllow, ch))
      throw new Error(
        `agent file ${path}: subscribe channel "${ch}" is not within allowSubscribe [${effAllow.join(", ")}]`,
      );

  // Sweep every scalar frontmatter key we don't model into meta, verbatim — connector hints
  // (face, etc.) ride here so core stays ignorant of surface-specific keys.
  const known = new Set(["name", "role", "kind", "description", "tags", "subscribe", "allowSubscribe", "allowPublish", "model", "capabilities", "owner"]);
  const meta: Record<string, string> = {};
  for (const [k, v] of Object.entries(fm)) if (!known.has(k) && typeof v === "string") meta[k] = v;

  return {
    name,
    role: str("role"),
    kind: kind as EndpointKind | undefined,
    description: str("description"),
    tags: list("tags"),
    subscribe,
    allowSubscribe,
    allowPublish,
    model: str("model"),
    capabilities: list("capabilities"),
    owner: str("owner"),
    meta: Object.keys(meta).length ? meta : undefined,
    persona: persona || undefined,
  };
}

/** Write an agent definition back to disk in the form {@link loadAgentFile} reads:
 *  the set frontmatter fields followed by the persona body. Round-trips through the
 *  parser; creates parent dirs. The runtime persona-definition path uses this to
 *  persist a peer-defined agent as config. */
export function saveAgentFile(path: string, def: AgentDef): void {
  if (!def.name) throw new Error('saveAgentFile: "name" is required');
  assertValidName(def.name);
  const lines = ["---", `name: ${fmScalar(def.name)}`];
  if (def.role) lines.push(`role: ${fmScalar(def.role)}`);
  if (def.kind) lines.push(`kind: ${fmScalar(def.kind)}`);
  if (def.description) lines.push(`description: ${fmScalar(def.description)}`);
  if (def.tags?.length) lines.push(`tags: [${def.tags.map(fmItem).join(", ")}]`);
  if (def.subscribe?.length) lines.push(`subscribe: [${def.subscribe.map(fmItem).join(", ")}]`);
  if (def.allowSubscribe?.length) lines.push(`allowSubscribe: [${def.allowSubscribe.map(fmItem).join(", ")}]`);
  if (def.allowPublish?.length) lines.push(`allowPublish: [${def.allowPublish.map(fmItem).join(", ")}]`);
  if (def.model) lines.push(`model: ${fmScalar(def.model)}`);
  if (def.capabilities?.length) lines.push(`capabilities: [${def.capabilities.map(fmItem).join(", ")}]`);
  if (def.owner) lines.push(`owner: ${fmScalar(def.owner)}`);
  if (def.meta) for (const [k, v] of Object.entries(def.meta)) lines.push(`${k}: ${fmScalar(v)}`);
  lines.push("---");
  const body = def.persona ? `${def.persona.trim()}\n` : "";
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${lines.join("\n")}\n\n${body}`);
}

/** Render a frontmatter scalar so {@link loadAgentFile} reads it back unchanged. Quotes values
 *  the parser would otherwise misread (a leading `[`, a `,`/`:`/`#`, edge whitespace, or empty);
 *  throws on values the line-based format can't represent (a newline, or both quote styles). */
function fmScalar(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error(`saveAgentFile: value cannot contain a newline: ${JSON.stringify(value)}`);
  if (value !== "" && value === value.trim() && !/^[[]/.test(value) && !/[,:#"']/.test(value)) return value;
  if (!value.includes('"')) return `"${value}"`;
  if (!value.includes("'")) return `'${value}'`;
  throw new Error(`saveAgentFile: value cannot contain both quote styles: ${JSON.stringify(value)}`);
}

/** A list item additionally cannot hold a comma — the parser splits on `,` before unquoting. */
function fmItem(value: string): string {
  if (value.includes(",")) throw new Error(`saveAgentFile: list item cannot contain a comma: ${JSON.stringify(value)}`);
  return fmScalar(value);
}

/** Resolve a name-or-path to an agent file. A path (absolute, contains a slash,
 *  or ends in `.md`) is used as given; a bare name maps to the directory
 *  convention `<root>/.cotal/agents/<name>.md`. */
export function agentFilePath(root: string, nameOrPath: string): string {
  if (isAbsolute(nameOrPath)) return nameOrPath;
  if (nameOrPath.includes("/") || nameOrPath.endsWith(".md")) return resolve(root, nameOrPath);
  return join(root, ".cotal", "agents", `${nameOrPath}.md`);
}

/** First free name in the series `base`, `base-2`, `base-3`, … — the first candidate for which
 *  `taken` returns false. The single source of the spawn auto-numbering scheme, shared by the
 *  manager's funnel (checked against its live + reserved slots) and `cotal spawn` (checked against
 *  the live mesh roster), so a colliding name numbers up identically whichever path spawns it. */
export function firstFreeName(base: string, taken: (name: string) => boolean): string {
  if (!taken(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken(candidate)) return candidate;
  }
}
