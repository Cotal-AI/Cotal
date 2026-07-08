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
 *   variant: high              # optional connector-defined model variant
 *   capabilities: [spawn]  # control-plane capabilities (spawn → may start/despawn others)
 *   theme: dark            # any unmodelled key is kept verbatim in AgentDef.meta, so a
 *                          #   connector can read its own launcher hints without core knowing them
 *   ---
 *   <the Markdown body is the persona — an appended system prompt>
 *
 * A launcher resolves a name (or path) to one of these, hands the persona/model/variant
 * to the agent process at spawn, and passes the file through so the joined
 * session reads its own card from it. Part of the wire contract's onboarding
 * half, alongside the join link.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { EndpointKind } from "./types.js";
import { assertValidName } from "./resolve.js";
import { assertValidChannel, channelInAllow, isConcreteChannel } from "./subjects.js";

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
  /** Per-channel attention DEFAULT: channels delivered but never waking this agent — per-channel
   *  `dnd`. Concrete channels within the read ACL (`allowSubscribe`). One-way operator default; the runtime toggle is
   *  connector state, never written back here (the file is a shared template). */
  quiet?: string[];
  /** Per-channel attention DEFAULT: channels dropped on receive (incl. `@`-mentions) — "don't receive
   *  this channel". Same one-way default semantics as {@link quiet}. */
  muted?: string[];
  /** Model override handed to the agent CLI (e.g. `claude --model`). */
  model?: string;
  /** Connector-defined model variant handed to the launcher (e.g. OpenCode reasoning effort). */
  variant?: string;
  /** Opaque, connector-specific launch options — an arbitrary key→value map that core never
   *  interprets. Connectors forward well-shaped keys raw into their host form (`claude` flags,
   *  OpenCode config); a connector with no option surface fails loud. `--opt k=v` on the CLI, a
   *  manifest `launchOptions:`, or a nested `launchOptions:` block here all feed the same bag. */
  launchOptions?: Record<string, unknown>;
  /** Capabilities this agent may exercise on the control plane (auth mode → minted into the
   *  cred's publish allow-list). Today `spawn` is the only one: it grants publish to the
   *  privileged control subject (start/purge/definePersona/named stop). Default-deny when
   *  absent — nats-server, not a handler, is the boundary. Granting authority is operator-level
   *  (`definePersona` is itself privileged), so no peer can self-grant via its own agent file.
   *  NOTE: because launchOptions is a raw passthrough, `spawn` is HOST-LAUNCH AUTHORITY — its holder
   *  can drive the connector's full launch surface on the manager host (Claude `--mcp-config` /
   *  `--add-dir` / permission flags, OpenCode agent-config keys). Grant it as host-launch authority,
   *  not as a narrow "add a teammate" permission. */
  capabilities?: string[];
  /** Authenticated id of the agent that first defined this persona via `definePersona` (P6). A
   *  POLICY field, not content: the privileged tier may *redefine* an existing file only if its
   *  `owner` equals the caller; everyone else needs the admin tier. Fail-closed — an ownerless
   *  file (legacy / operator-written) is admin-only, and a caller can never claim ownership of an
   *  existing file. Set once at creation (owner = creator), preserved on every later redefine. */
  owner?: string;
  /** Frontmatter keys not modelled above, kept verbatim so a connector can read its own launcher
   *  hints without core knowing about each one. */
  meta?: Record<string, string>;
  /** Markdown body — the agent's persona / appended system prompt. */
  persona?: string;
}

/** Parse the frontmatter block as YAML (the `yaml` library — spec-compliant quoting/escaping and
 *  safe scalar typing, so a value with a `:`/`#`/quote can't be misread). Must be a mapping; a
 *  sequence, scalar, or malformed block fails loud. Values keep their YAML types (string, number,
 *  boolean, nested map/list); {@link loadAgentFile} coerces the modelled scalar fields. */
function parseFrontmatter(src: string, path: string): Record<string, unknown> {
  let doc: unknown;
  try {
    doc = parseYaml(src);
  } catch (e) {
    throw new Error(`agent file ${path}: invalid YAML frontmatter — ${(e as Error).message}`);
  }
  if (doc === null || doc === undefined) return {};
  if (typeof doc !== "object" || Array.isArray(doc))
    throw new Error(`agent file ${path}: frontmatter must be a YAML mapping (key: value pairs)`);
  return doc as Record<string, unknown>;
}

/** Load and parse an agent definition file (Markdown + `---` frontmatter). */
export function loadAgentFile(path: string): AgentDef {
  const src = readFileSync(path, "utf8");
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(src);
  if (!m) throw new Error(`agent file ${path}: missing "---" frontmatter block`);
  const fm = parseFrontmatter(m[1], path);
  const persona = m[2].trim();

  const str = (k: string): string | undefined => {
    const v = fm[k];
    if (v === undefined || v === null) return undefined;
    if (typeof v === "object") throw new Error(`agent file ${path}: "${k}" must be a scalar`);
    return String(v);
  };
  const list = (k: string): string[] | undefined => {
    const v = fm[k];
    if (v === undefined || v === null) return undefined;
    return (Array.isArray(v) ? v : [v]).map((x) => {
      if (x === null || typeof x === "object") throw new Error(`agent file ${path}: "${k}" list items must be scalars`);
      return String(x);
    });
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
        `agent file ${path}: "${old}" was renamed - use "subscribe"/"allowSubscribe" (read) and "allowPublish" (post)`,
      );

  const subscribe = list("subscribe");
  const allowSubscribe = list("allowSubscribe");
  const allowPublish = list("allowPublish");
  const quiet = list("quiet");
  const muted = list("muted");
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

  // Per-channel attention defaults (quiet/muted): concrete channels within the read ACL (allowSubscribe)
  // — silencing a channel you can't read, or with a wildcard the ingest match would never hit, is a config error. A
  // channel can't be both at once. Fail loud (no silent no-op), matching the checks above.
  const both = (quiet ?? []).filter((c) => (muted ?? []).includes(c));
  if (both.length)
    throw new Error(`agent file ${path}: channel(s) [${both.join(", ")}] are in both quiet and muted - pick one`);
  for (const [field, chans] of [["quiet", quiet], ["muted", muted]] as const)
    for (const ch of chans ?? []) {
      try {
        assertValidChannel(ch);
      } catch (e) {
        throw new Error(`agent file ${path}: ${(e as Error).message}`);
      }
      if (!isConcreteChannel(ch))
        throw new Error(`agent file ${path}: ${field} channel "${ch}" must be a concrete channel (no wildcard)`);
      if (!channelInAllow(effAllow, ch))
        throw new Error(`agent file ${path}: ${field} channel "${ch}" is not within your read ACL / allowSubscribe [${effAllow.join(", ")}]`);
    }

  // Opaque connector-specific launch options — a mapping core never interprets (each connector
  // reads its own keys). A scalar/sequence here is a config error (it must be `key: value` pairs).
  const launchOptionsRaw = fm["launchOptions"];
  let launchOptions: Record<string, unknown> | undefined;
  if (launchOptionsRaw !== undefined && launchOptionsRaw !== null) {
    if (typeof launchOptionsRaw !== "object" || Array.isArray(launchOptionsRaw))
      throw new Error(`agent file ${path}: "launchOptions" must be a mapping of key: value pairs`);
    launchOptions = launchOptionsRaw as Record<string, unknown>;
  }

  // Sweep every scalar frontmatter key we don't model into meta, verbatim — connector launcher
  // hints ride here so core stays ignorant of surface-specific keys.
  const known = new Set(["name", "role", "kind", "description", "tags", "subscribe", "allowSubscribe", "allowPublish", "quiet", "muted", "model", "variant", "launchOptions", "capabilities", "owner"]);
  const meta: Record<string, string> = {};
  for (const [k, v] of Object.entries(fm)) if (!known.has(k) && v !== null && typeof v !== "object") meta[k] = String(v);

  return {
    name,
    role: str("role"),
    kind: kind as EndpointKind | undefined,
    description: str("description"),
    tags: list("tags"),
    subscribe,
    allowSubscribe,
    allowPublish,
    quiet,
    muted,
    model: str("model"),
    variant: str("variant"),
    launchOptions,
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
  // Build the frontmatter mapping in read order, then serialize with the `yaml` library — it owns
  // all quoting/escaping (a value with a `:`/`#`/`[`/quote round-trips safely, which the old
  // hand-rolled writer had to special-case). `lineWidth: 0` keeps scalars on one line (no folding).
  const fm: Record<string, unknown> = { name: def.name };
  if (def.role) fm.role = def.role;
  if (def.kind) fm.kind = def.kind;
  if (def.description) fm.description = def.description;
  if (def.tags?.length) fm.tags = def.tags;
  if (def.subscribe?.length) fm.subscribe = def.subscribe;
  if (def.allowSubscribe?.length) fm.allowSubscribe = def.allowSubscribe;
  if (def.allowPublish?.length) fm.allowPublish = def.allowPublish;
  if (def.quiet?.length) fm.quiet = def.quiet;
  if (def.muted?.length) fm.muted = def.muted;
  if (def.model) fm.model = def.model;
  if (def.variant) fm.variant = def.variant;
  if (def.launchOptions && Object.keys(def.launchOptions).length) fm.launchOptions = def.launchOptions;
  if (def.capabilities?.length) fm.capabilities = def.capabilities;
  if (def.owner) fm.owner = def.owner;
  if (def.meta) for (const [k, v] of Object.entries(def.meta)) fm[k] = v;
  const frontmatter = stringifyYaml(fm, { lineWidth: 0 }).trimEnd();
  const body = def.persona ? `${def.persona.trim()}\n` : "";
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `---\n${frontmatter}\n---\n\n${body}`);
}

/** Resolve a name-or-path to an agent file. A path (absolute, contains a slash — `/` or, on
 *  Windows, `\` — or ends in `.md`) is used as given; a bare name maps to the directory
 *  convention `<root>/.cotal/agents/<name>.md`. */
export function agentFilePath(root: string, nameOrPath: string): string {
  if (isAbsolute(nameOrPath)) return nameOrPath;
  if (nameOrPath.includes("/") || nameOrPath.includes("\\") || nameOrPath.endsWith(".md"))
    return resolve(root, nameOrPath);
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
