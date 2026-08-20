/**
 * The spawned-agent env (P3) - the single chokepoint for what a child process sees.
 *
 * DEFAULT: a spawned agent INHERITS the operator's environment. A coding harness the operator
 * installed and configured should behave under `cotal spawn` the way it behaves when they run it
 * themselves, and Cotal has no business holding an opinion about which inference providers exist or
 * which variables a harness reads. The list of vendor key names that used to live here was the tell:
 * every new provider needed a change in Cotal before it would work through a managed spawn.
 *
 * EXCEPT Cotal's own `COTAL_*` namespace, which is RESET. That is not an opinion about the
 * operator's environment; it is Cotal refusing to let one agent's identity become another's. A
 * connector re-supplies the `COTAL_*` a child should have, but many of those assignments are
 * CONDITIONAL - {@link aclEnv} omits an empty ACL so the connector can defer to the persona file,
 * {@link materialEnv} returns `{}` when a launch carries nothing to hand over, `if (opts.role)`,
 * `if (opts.lifecycleUid)` - so an inherited value is never overwritten and survives into a child
 * that was never granted it.
 *
 * The prefix is stripped WHOLESALE rather than by a named deny-list, because the danger is
 * ASYMMETRY rather than any single omission: `COTAL_EVENTS` and `COTAL_WORKSPACE_ROOT` are set by
 * opencode/claude/codex and NOT by hermes/pi, `COTAL_CHANNEL` only by claude, `COTAL_VARIANT` only
 * by opencode/codex, the `COTAL_CODEX_*` family only by codex. A hand-maintained deny-list names
 * what its author remembers. The repo has a worked example: six suite files reached main each
 * blanking exactly `COTAL_SPACE`, `COTAL_SERVERS` and `COTAL_CREDS` by hand before spreading
 * `...process.env` into a `cotal attach` child, which let the lifecycle uid, the control token, both
 * identity quads and {@link LAUNCH_MATERIAL_ENV} through to a process that reads connection
 * material. {@link OPERATOR_ENV_KEEP} is the inverse and is safe for the same reason a deny-list is
 * not: every name on it is one no connector assigns per spawn, so a new connector cannot invalidate
 * it by forgetting something.
 *
 * OPT-IN CONTAINMENT: an operator who wants the child confined sets `spawn.env` in the cotal config
 * file; the caller resolves it and passes it as `envAllow`. The child then gets the OS allow-list
 * plus exactly the names declared there, and nothing else.
 *
 * Scope this is HONEST about (P6). NEITHER mode closes filesystem secret access: HOME / XDG /
 * platform config dirs are forwarded either way, so a child with a shell reads ~/.aws, ~/.ssh,
 * ~/.config and ~/.cotal straight off disk. An allow-list stops env-ONLY secrets - an
 * `aws-vault exec` or `op run` shell, CI-injected values - and nothing that has a file behind it.
 * Nor does either mode close model-key exfil: a key-based agent holds its provider key in its own
 * process in order to do inference. What DOES narrow under inherit is that Cotal's own connection
 * material is no longer in the environment at all: {@link materialEnv} moved the credential, the
 * broker address and the control token behind a 0600 file, so what a child now inherits from the
 * `COTAL_*` namespace is a path this function removes, not a secret.
 */
import {
  eventChannel,
  LAUNCH_MATERIAL_ENV,
  parsePrincipalKey,
  principalKey,
  writeLaunchMaterial,
  type LaunchMaterial,
  type McpServerSpec,
} from "@cotal-ai/core";

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

/** Cotal's own per-session namespace. Everything under this prefix is reset before a child starts,
 *  except {@link OPERATOR_ENV_KEEP}. Compared case-INSENSITIVELY: Windows env lookup is
 *  case-insensitive, so a stray `Cotal_Creds` must not slip past a case-sensitive test. */
const SESSION_ENV_PREFIX = "COTAL_";

/** The `COTAL_*` an operator sets MACHINE-WIDE, which a child legitimately needs. The qualifying
 *  property is not "harmless" but "no connector assigns it per spawn": a name no launch path writes
 *  cannot carry one agent's grant into another, which is why this list stays correct as connectors
 *  are added and a deny-list would not. `COTAL_HOME` is the load-bearing entry - it redirects the
 *  mesh registry, and a child that shells out to `cotal` must resolve the one its parent did.
 *  `COTAL_CODEX_BIN` and its siblings are operator binary overrides, and sit here precisely BECAUSE
 *  the neighbouring per-launch `COTAL_CODEX_HOME`/`_CONFIG`/`_TUI`/`_PROMPT` do not. */
export const OPERATOR_ENV_KEEP = [
  "COTAL_HOME",
  "COTAL_FEEDBACK_KEY",
  "COTAL_FEEDBACK_EMAIL",
  "COTAL_FEEDBACK_URL",
  "COTAL_DEFAULT_AGENT",
  "COTAL_DEFAULT_PERSONA",
  "COTAL_SKIP_CONNECTOR_SEED",
  "COTAL_SKIP_ASSIST",
  "COTAL_DETACH_KEY",
  "COTAL_COMPLETE_DEBUG",
  "COTAL_DEBUG",
  "COTAL_SERVE_HEADLESS",
  "COTAL_EVENTS_DEFAULT",
  "COTAL_MEMBERSHIP_INTERVAL_MS",
  "COTAL_DELIVERY_BROKER_GONE_MS",
  "COTAL_IDP_TIMEOUT_MS",
  "COTAL_CODEX_BIN",
  "COTAL_OPENCODE_BIN",
  "COTAL_ORCA_BIN",
] as const;

/** Build the base env a spawned agent runs with.
 *
 *  DEFAULT (`envAllow` absent): the operator's environment minus {@link SESSION_ENV_PREFIX}, keeping
 *  {@link OPERATOR_ENV_KEEP}. The connector layers this child's own `COTAL_*` on top, so every
 *  per-session name it ends up with was granted to IT.
 *
 *  OPT-IN (`envAllow` present, from the config file's `spawn.env`): the OS allow-list plus exactly
 *  the declared names and `mcpKeys` (the `${VAR}` secrets a shared MCP server references, see
 *  {@link mcpServerEnvKeys}). Each is copied BY NAME and only when present. An EMPTY array is a real
 *  policy - the OS allow-list alone - and not "unset", which is why the mode is chosen on
 *  `!== undefined` rather than on length.
 *
 *  Allow-list matching is CASE-INSENSITIVE and each value is copied under the OS's OWN key casing:
 *  Windows spells these `Path`/`ComSpec`/`windir`, so a canonical-only copy would either miss them
 *  (a plain read of `process.env.SystemRoot` differs from `process.env.systemroot`) or, worse, emit
 *  BOTH `Path` and `PATH` - a case-duplicate Windows process creation chokes on. Keying off the
 *  source env's actual casing (one entry per lowercased name) forwards each var exactly once. */
export function launchEnv(
  opts: { mcpKeys?: readonly string[]; envAllow?: readonly string[] } = {},
): Record<string, string> {
  if (opts.envAllow !== undefined) {
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
    for (const k of [...opts.envAllow, ...(opts.mcpKeys ?? [])]) copy(k);
    return env;
  }

  // Inherit. `mcpKeys` needs no handling in this mode: a `${VAR}` a shared MCP server references is
  // already in the operator's environment, which is what the child is being given.
  const keep = new Set<string>(OPERATOR_ENV_KEEP);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    const canon = k.toUpperCase();
    if (canon.startsWith(SESSION_ENV_PREFIX) && !keep.has(canon)) continue;
    env[k] = v;
  }
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

/**
 * The launch's CONNECTION MATERIAL as a private file, and one env entry naming it.
 *
 * This replaces `userAuthEnv` and the per-connector `COTAL_CREDS` / `COTAL_SERVERS` /
 * `COTAL_CONTROL_TOKEN` assignments it used to sit beside. Those put the broker address, the
 * credential and a control-plane bearer into the seat's process environment, which every descendant
 * of the seat inherits: the build it runs, the linter, the third-party CLI, the test suite that
 * reads its broker from the environment. Nothing in that chain asked for any of it, and there is no
 * moment where a human sees a credential being handed over, so there is no natural moment to object.
 *
 * Now they ride a 0600 file (see `writeLaunchMaterial`) and only its PATH is exported. The identity
 * that is not secret - space, name, role, id, lifecycle uid, the ACLs, the control SOCKET path -
 * stays in the environment where the launcher's contract has always put it, because a descendant
 * learning the seat's name is not the failure.
 *
 * Refuses a creds+userAuth combination here (one launch, one identity plane - U10), which is where
 * `userAuthEnv` refused it.
 */
export function materialEnv(opts: {
  creds?: string;
  servers?: string;
  token?: string;
  controlToken?: string;
  userAuth?: { owner: string; actor: string; sentinelCredsPath: string; bearerCmd: string[] };
}): Record<string, string> {
  if (opts.userAuth && opts.creds)
    throw new Error("launch: creds (static auth) and userAuth (user-mode auth) are mutually exclusive — one launch carries one identity plane");
  const material: LaunchMaterial = {};
  if (opts.creds) material.creds = opts.creds;
  if (opts.servers) material.servers = opts.servers;
  if (opts.token) material.token = opts.token;
  if (opts.controlToken) material.controlToken = opts.controlToken;
  if (opts.userAuth) material.userAuth = opts.userAuth;
  // Nothing to hand over (an open mesh launched with no control endpoint) → no file and no env
  // entry, rather than a file that says nothing. writeLaunchMaterial refuses the empty case too;
  // this is the caller-side half of the same rule.
  if (Object.keys(material).length === 0) return {};
  return { [LAUNCH_MATERIAL_ENV]: writeLaunchMaterial(material) };
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
