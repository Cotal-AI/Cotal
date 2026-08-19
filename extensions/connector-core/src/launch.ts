/**
 * The spawned-agent env allow-list (P3) — the single chokepoint for what a child process sees.
 *
 * Connectors build the child's env as `{ ...launchEnv(...), <COTAL_* identity>, <connector vars> }`
 * and the runtimes pass ONLY that (never `...process.env`). So the operator's *unrelated* env
 * (AWS creds, GH tokens, other service keys sitting in their shell) stops bleeding into every
 * spawned child. What a child sees is auditable from the spec, not "whatever the manager
 * inherited."
 *
 * Scope this is HONEST about (P6): it closes ENV-VAR bleed. It does NOT close (i) model-key
 * exfil for key-based providers — the agent holds the key in its own process to do inference, so
 * a compromised agent exfils from its OWN env, spawn-gating the key only breaks the child's LLM
 * function (the real fix is per-agent model auth, a separate roadmap item); nor (ii) filesystem
 * secret access — HOME / XDG / platform config dirs are forwarded, so a child can still read
 * ~/.aws / ~/.ssh / ~/.config off disk (needs a workspace sandbox, a separate control).
 */
import { eventChannel, parsePrincipalKey, principalKey, type McpServerSpec } from "@cotal-ai/core";

/** OS env a coding-agent TUI genuinely needs to run — find its binary (PATH), render (TERM /
 *  COLORTERM), resolve home/config/data roots (HOME / XDG_*_HOME on Unix,
 *  USERPROFILE / APPDATA / LOCALAPPDATA on Windows), locale (LANG / LC_*), timezone (TZ), temp
 *  dirs, session/runtime dir (XDG_RUNTIME_DIR), and the shell it may invoke. NOT a model key,
 *  NOT an operator secret. A fixed, named allow-list; each entry is forwarded only when present,
 *  so the Unix-only and Windows-only names below coexist harmlessly on either OS. Names are matched
 *  case-insensitively against the source env and copied under the source's own key (see
 *  {@link launchEnv}), so Windows casing (`Path`, `ComSpec`, `windir`) is forwarded without ever
 *  emitting a case-duplicate (`Path` AND `PATH`) that Windows process creation would choke on. */
const OS_ENV_ALLOW = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "USER",
  "LOGNAME",
  "SHELL",
  "COMSPEC",
  "PATHEXT",
  "TERM",
  "COLORTERM",
  "COLORFGBG",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "TZ",
  "TEMP",
  "TMPDIR",
  "TMP",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_RUNTIME_DIR",
  // Windows system env. SystemRoot is mandatory: without it a spawned process aborts at startup
  // (node `InitializeOnce`, winsock/ICU can't load) — and a `pty`-runtime (ConPTY) child does NOT
  // inherit it the way a plain child_process does, so a manager-spawned agent dies before its first
  // line. The rest let agents resolve the system drive, arch, and Program/Data roots they shell out
  // to. Absent on POSIX (skipped); present only on Windows.
  "SystemRoot",
  "windir",
  "SystemDrive",
  "PROCESSOR_ARCHITECTURE",
  "NUMBER_OF_PROCESSORS",
  "ALLUSERSPROFILE",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "CommonProgramFiles",
  "PUBLIC",
] as const;

/** Model-provider API keys a key-based connector may forward to its child. claude needs none
 *  (macOS Keychain / OAuth token, not an env key) → strong isolation for free; opencode/hermes
 *  need the key for the provider behind the agent's model → forward just these, by NAME, only if
 *  present. This is the single chokepoint for model-key forwarding — the seam for spawner-
 *  conditional gating (per-agent model auth) later. Never `...process.env`. */
export const MODEL_PROVIDER_KEYS = [
  "OPENCODE_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "NOUS_API_KEY",
] as const;

/** Build the base env a spawned agent runs with: the OS allow-list plus any named keys the
 *  connector declares the agent needs — `providerKeys` (the model-provider key) and `mcpKeys`
 *  (the `${VAR}` secrets a shared MCP server references, see {@link mcpServerEnvKeys}). Every entry
 *  is copied from the manager's env BY NAME and only when present — never required, never spread
 *  wholesale, so the operator's unrelated secrets don't bleed into the child (P3).
 *
 *  Matching is CASE-INSENSITIVE and each value is copied under the OS's OWN key casing: Windows
 *  spells these `Path`/`ComSpec`/`windir`, so a canonical-only copy would either miss them (a plain
 *  read of `process.env.SystemRoot` differs from `process.env.systemroot`) or, worse, emit BOTH
 *  `Path` and `PATH` — a case-duplicate Windows process creation chokes on. Keying off the source
 *  env's actual casing (one entry per lowercased name) forwards each var exactly once. */
export function launchEnv(
  opts: { providerKeys?: readonly string[]; mcpKeys?: readonly string[] } = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  // lowercased name -> the OS's actual key casing; one entry per var (the OS env has no case-dup),
  // so every allow-list name resolves to a single source key and the result carries no case-dup.
  const sourceKey = new Map<string, string>();
  for (const k of Object.keys(process.env)) sourceKey.set(k.toLowerCase(), k);
  const copy = (name: string): void => {
    const src = sourceKey.get(name.toLowerCase());
    if (src === undefined) return;
    const v = process.env[src];
    if (v !== undefined) env[src] = v;
  };
  for (const k of OS_ENV_ALLOW) copy(k);
  for (const k of [...(opts.providerKeys ?? []), ...(opts.mcpKeys ?? [])]) copy(k);
  return env;
}

/** The agent's resolved access policy as `COTAL_*` env, when present. Forwarded by each connector
 *  so the spawned session's runtime read/post set matches the creds the manager minted from the
 *  same policy. Without it a manifest-spawned agent — whose materialized persona carries no access
 *  frontmatter — falls back to `["general"]`, which its scoped creds deny, so it joins nothing.
 *  Empty/absent lists are omitted: the connector then defers to the persona file or the `general`
 *  baseline (the no-channel case), preserving the persona-spawn path unchanged. */
export function aclEnv(opts: {
  subscribe?: string[];
  allowSubscribe?: string[];
  allowPublish?: string[];
  capabilities?: string[];
}): Record<string, string> {
  const env: Record<string, string> = {};
  if (opts.subscribe?.length) env.COTAL_SUBSCRIBE = opts.subscribe.join(",");
  if (opts.allowSubscribe?.length) env.COTAL_ALLOW_SUBSCRIBE = opts.allowSubscribe.join(",");
  if (opts.allowPublish?.length) env.COTAL_ALLOW_PUBLISH = opts.allowPublish.join(",");
  // Control-plane capabilities (e.g. `spawn`) gate cotal_spawn/cotal_persona in the connector's tool
  // list. Forward them on the same rail as the read/post ACL, or a manifest-spawned agent (no persona
  // file) gets `config.capabilities = []` and the tools stay hidden even though its creds authorize them.
  if (opts.capabilities?.length) env.COTAL_CAPABILITIES = opts.capabilities.join(",");
  return env;
}

/** Property names that, assigned onto a plain object as `obj[k] = v`, corrupt its prototype chain
 *  (`__proto__`) or shadow a built-in the connector relies on (`constructor`/`prototype`). Refused
 *  for every connector — a launch option is a flag/config field, never these. This is process
 *  integrity (don't corrupt the JS config object a connector builds), not flag policy. */
const UNSAFE_LAUNCH_OPTION_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** A launch-option key must name ONE flag / config field: a letter-led token of letters, digits,
 *  `-` and `_`. This rejects, in particular, a key that embeds `=` — the CLI `--opt k=v` parser
 *  splits on the first `=`, but the map sources (persona `launchOptions:`, manifest, MCP `cotal_spawn`)
 *  do not, so a key like `"mcp-config=/tmp/evil.json"` would otherwise render as the single argv token
 *  `--mcp-config=/tmp/evil.json` — a garbled flag rather than the intended `--mcp-config /tmp/...`. It
 *  also rejects whitespace, control characters, and the empty key. */
const LAUNCH_OPTION_KEY = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** Validate a connector's opaque {@link LaunchOpts.launchOptions} bag and return its entries for the
 *  connector to render into its host form (CLI flags / config / env). This is a RAW passthrough: the
 *  connector forwards every option as-is. The trust boundary is the spawn capability itself — WHO may
 *  spawn (the caller's authenticated identity), not WHICH flags a spawn carries. An operator running
 *  `cotal spawn --opt` on their own host can already run the agent binary directly with any flag, so
 *  capping their flags is theater; a mesh peer's `cotal_spawn` is bounded by whether it holds the
 *  spawn capability at all. So no allow-list, no deny-list — the only check is a key-SHAPE guard for
 *  process integrity (see {@link LAUNCH_OPTION_KEY}, {@link UNSAFE_LAUNCH_OPTION_KEYS}): a key must
 *  name one flag / config field, never a prototype-polluting name or an `=`-embedding token that
 *  would corrupt the config object or garble a rendered flag. Core never sees this; each connector
 *  calls it for the surface IT renders. */
export function connectorLaunchOptions(
  connector: string,
  launchOptions: Record<string, unknown> | undefined,
): [string, unknown][] {
  if (!launchOptions) return [];
  for (const k of Object.keys(launchOptions))
    if (UNSAFE_LAUNCH_OPTION_KEYS.has(k) || !LAUNCH_OPTION_KEY.test(k))
      throw new Error(`${connector} connector: launch option key ${JSON.stringify(k)} is not a valid flag name`);
  return Object.entries(launchOptions);
}

/** USER-MODE launch identity as `COTAL_*` env, when present — the one place the LaunchOpts.userAuth
 *  → env mapping lives, so every connector forwards the identical contract configFromEnv parses.
 *  Refuses a creds+userAuth combination here (one launch, one identity plane — U10). */
export function userAuthEnv(opts: {
  creds?: string;
  userAuth?: { owner: string; actor: string; sentinelCredsPath: string; bearerCmd: string[] };
}): Record<string, string> {
  if (!opts.userAuth) return {};
  if (opts.creds)
    throw new Error("launch: creds (static auth) and userAuth (user-mode auth) are mutually exclusive — one launch carries one identity plane");
  return {
    COTAL_OWNER: opts.userAuth.owner,
    COTAL_ACTOR: opts.userAuth.actor,
    COTAL_SENTINEL_CREDS: opts.userAuth.sentinelCredsPath,
    COTAL_BEARER_CMD: JSON.stringify(opts.userAuth.bearerCmd),
  };
}

/** The per-agent EVENT channel and its classifier, RE-EXPORTED FROM CORE.
 *
 *  They were defined here, and they moved. The convention is one every connector publishes to and
 *  every reader has to recognise, so it is a protocol shape rather than an adapter's choice, and it
 *  now lives beside the frame's identity in `packages/core/src/event-channel.ts`. The comment that
 *  used to sit here argued the opposite in those words: that an agent event stream is a connector
 *  feature and a classifier for the convention belongs beside its constructor. The second half was
 *  right and is why they moved TOGETHER; the first half was wrong, and the evidence is that the two
 *  surfaces which most need to classify, the console's mesh view and the dashboard, cannot reach
 *  this package at all.
 *
 *  `isEventChannel` is no longer a prefix test. It derives the principal and refuses a name that
 *  does not resolve to one, which is what retires the known limit this file used to document. The
 *  reasoning for that direction is on the core function.
 *
 *  Re-exported rather than relocated silently, so every existing importer of `../src/launch.js`
 *  keeps working and the move is not a breaking change to this package's surface. */
export {
  EVENT_CHANNEL_PREFIX,
  eventChannel,
  eventChannelPrincipal,
  isEventChannel,
} from "@cotal-ai/core";

/** The event channel for a LIVE session, derived from the endpoint's own principal — what the
 *  broker will actually enforce against, never `config.name` and never the launch env.
 *
 *  REFUSES AN EPHEMERAL ACTOR LOUDLY, and that refusal is the whole point. An endpoint with neither
 *  a declared `card.id` nor creds SELF-MINTS a random actor per process ({@link CotalEndpoint} dev
 *  branch), so its channel would differ on every restart and could never match a grant minted in
 *  advance. The tempting repair — fall back to the display name for that one mode — would reinstate
 *  the fused-channel defect on the single path that has no credential to grade it against, which is
 *  where it would live forever. So the mode fails closed: events are unavailable without a stable
 *  identity, and the operator is told which.
 *
 *  Structurally typed rather than importing `CotalEndpoint`, so the three connectors' publish paths
 *  and a test can drive the SAME refusal. */
export function eventChannelForSession(
  ep: { principal: { owner: string; actor: string }; actorIsEphemeral: boolean },
): string {
  if (ep.actorIsEphemeral)
    throw new Error(
      "events are not available for a session with a self-minted identity: this endpoint has no " +
        "declared id and no credentials, so its actor is a fresh random token per process and its " +
        "event channel could never match a grant. Launch it with an identity (an authed mesh, or " +
        "an explicit id) to publish events.",
    );
  return eventChannel(ep.principal);
}

/**
 * Resolve a DISPLAY NAME to its event channel, against the presence records a reader already holds.
 *
 * **THIS EXISTS BECAUSE THE RE-KEY MADE THE CHANNEL UNGUESSABLE, AND THAT COST IS REAL.** While the
 * channel was `events.<sanitised name>`, a viewer holding a roster row could construct it by string
 * arithmetic. It now carries the principal — in the dev default that is `events.local.<56-char
 * nkey>` — which nothing about a display name predicts. The isolation defect the re-key fixed was
 * worth that; leaving every reader to invent its own lookup would not be, because each one would
 * invent a different answer to the ambiguity below and most would invent the wrong one.
 *
 * **AMBIGUITY IS REFUSED, NOT RESOLVED, AND IT IS THE WHOLE POINT OF THE FUNCTION.** Display names
 * are not unique and never were: `assertValidName` permits two agents to carry the same one, and
 * this mesh runs duplicate lane names routinely. A resolver that returned the FIRST match would
 * reinstate the exact defect the re-key removed — two distinct principals fused onto one answer —
 * except now at the READ end, where it is worse: a viewer would silently display one agent's stream
 * under another agent's name, and nothing on the wire would look wrong. So a name matching two
 * DIFFERENT principals throws and names both.
 *
 * **Rows that agree on the principal are ONE agent, not an ambiguity.** A roster carries stale
 * presence within its TTL, so the same agent legitimately appears more than once; refusing that
 * would make the function useless exactly when a reader most needs it. The test is on the resolved
 * principal, never on the row count.
 *
 * **It resolves from `owner`/`actor` when present and falls back to parsing `id`** — both are the
 * same principal by construction (`card.id` is `principalKey(owner, actor).key`), and `id` is the
 * field every peer is guaranteed to carry. It does NOT guess: a row whose principal cannot be
 * determined from either is reported as such rather than skipped, because silently skipping the one
 * row that mattered turns a wrong answer into a confident wrong answer.
 *
 * @throws naming the failure, never returning a sentinel — a reader that got `undefined` would show
 *   an empty pane, and an empty pane is indistinguishable from a correctly-empty one.
 */
export function eventChannelForName(
  name: string,
  peers: readonly { name: string; id?: string; owner?: string; actor?: string }[],
): string {
  const matches = peers.filter((p) => p.name === name);
  if (matches.length === 0)
    throw new Error(
      `no peer named "${name}" in the ${peers.length} presence record(s) given, so its event ` +
        `channel cannot be resolved. Event channels are keyed on the agent's PRINCIPAL ` +
        `(events.<owner>.<actor>) and cannot be derived from a display name alone — the name has to ` +
        `be matched against presence first.`,
    );

  const seen = new Map<string, { owner: string; actor: string }>();
  const unresolvable: string[] = [];
  for (const p of matches) {
    const principal =
      p.owner && p.actor ? { owner: p.owner, actor: p.actor } : parsePrincipalKey(p.id ?? "");
    if (!principal) {
      unresolvable.push(p.id ?? "<no id>");
      continue;
    }
    seen.set(principalKey(principal.owner, principal.actor).key, principal);
  }

  if (seen.size > 1)
    throw new Error(
      `"${name}" is ambiguous: it matches ${seen.size} distinct principals (${[...seen.keys()]
        .map((k) => `"${k}"`)
        .join(", ")}), and they are different agents with different event channels. Display names ` +
        `are not identities and are not unique, so resolving this to any one of them would show one ` +
        `agent's stream under another's name. Address the principal you mean.`,
    );

  const only = [...seen.values()][0];
  if (!only)
    throw new Error(
      `"${name}" matched ${matches.length} presence record(s) but none carries a resolvable ` +
        `principal (saw ${unresolvable.map((u) => `"${u}"`).join(", ")}). An event channel is keyed ` +
        `on <owner>.<actor>, so a record with neither an owner/actor pair nor a principal-shaped id ` +
        `names no channel.`,
    );
  return eventChannel(only);
}

/** The environment-variable NAMES a set of shared MCP server specs reference via `${VAR}` /
 *  `${VAR:-default}` (in command/args/env/url/headers). The single source of which operator vars
 *  a shared server needs: forwarded BY NAME through {@link launchEnv} (`mcpKeys`), never
 *  `...process.env`, so secret keys keep living in the operator's env (and the `.mcp.json`-style
 *  config stays a `${VAR}` reference, not a plaintext secret). */
export function mcpServerEnvKeys(servers: Record<string, McpServerSpec>): string[] {
  const names = new Set<string>();
  const scan = (s: string | undefined): void => {
    if (!s) return;
    for (const m of s.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g)) names.add(m[1]);
  };
  for (const spec of Object.values(servers)) {
    scan(spec.command);
    spec.args?.forEach(scan);
    if (spec.env) for (const v of Object.values(spec.env)) scan(v);
    scan(spec.url);
    if (spec.headers) for (const v of Object.values(spec.headers)) scan(v);
  }
  return [...names];
}
