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
import { createHash } from "node:crypto";
import { assertValidName, type McpServerSpec } from "@cotal-ai/core";

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

/** The per-agent EVENT channel: `events.<name>`, the name lowercased and reduced to subject-safe
 *  characters. The SINGLE source of this connector convention — connectors publish here (their
 *  plugin/runtime path AND their `Connector.eventChannel` method both call this), and the manager
 *  grants pub on it through that contract method. It lives in the connector layer, NOT core: an
 *  agent event stream is a connector feature, not the normative wire standard.
 *
 *  **Replaces `transcriptChannel()` and the `tr-<name>` convention outright** — abolished means
 *  replaced, not both running. The prefix moves from a glyph-line mirror to a namespace that can hold
 *  per-session sub-channels (`events.<name>.<session>`), which the flat old name could not: every
 *  session shared one channel and therefore one retention budget.
 *
 *  **A grant on `events.<name>` does NOT cover `events.<name>.<session>`** — `patternCovers` is false
 *  in both directions between `a` and `a.>`, so a caller needing both must mint BOTH patterns.
 *
 *  **NOTHING MINTS THE DESCENDANT PATTERN TODAY, AND NOTHING EMITS ON ONE.** An earlier version of
 *  this comment said minting both "is the manager's job", which read as a description of existing
 *  behaviour; the manager appends only `eventChannel(name)`. Per-session sub-channels are a LATER
 *  step — no connector emits to one, so the absent grant is not a mute stream today. It becomes one
 *  the moment anything publishes to `events.<name>.<session>`, and the grant must be minted in the
 *  same change that starts emitting, not before and not after.
 *
 *  This is stated as an unbuilt future rather than a delegated duty because a comment asserting
 *  another component's behaviour is a test nobody wrote — the third such overclaim found in this
 *  surface (the seal's window, the resume barrier's write direction, and this).
 *
 *  Sanitizer kept exact (illegal runs collapse to a single `-`), so a name that mapped to one channel
 *  under the old prefix maps to one channel under the new one. */
export function eventChannel(name: string): string {
  const safe = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  // COLLISION-RESISTANT — deliberately NOT called injective, because it is not.
  //
  // A truncated digest cannot guarantee that no two inputs share an output; it makes the chance
  // negligible. Injective would require a REVERSIBLE encoding, and encoding both case and every
  // separator into `[a-z0-9_-]` would turn `Ada Lovelace` into something no operator can read on a
  // channel list — a real cost against a vanishing risk. So the trade is taken deliberately and the
  // name says which property it has. An earlier version of this comment said "INJECTIVE", which
  // claimed universally what the cells prove over a measured set: the exact overclaim class this
  // function was being fixed for.
  //
  // THE BOUND, stated so it can be judged rather than trusted: 16 hex characters of SHA-256 = 64
  // bits, and the digest only has to separate names that ALREADY share a sanitised form. Two such
  // names collide at ~2^-64; the birthday bound within one sanitised group is ~2^32 names.
  //
  // The sanitiser alone is not even collision-resistant: `assertValidName` deliberately allows internal spaces and
  // dots ("human display names like 'Ada Lovelace'", `resolve.ts:80-84`), so `Alice Bob`,
  // `Alice.Bob`, `alice bob` and `alice-bob` all collapsed to `events.alice-bob` — and case-folding
  // collapses `Alice` onto `alice` besides. Measured: 8 valid distinct names → 3 channels.
  //
  // That is an ISOLATION defect, not a cosmetic one. The publish grant is minted FROM this value
  // (`manager.ts`, the `eventChannel` append), so two distinct principals received the same grant
  // and published to the same subject — a per-agent stream silently shared. Spawn de-duplication
  // does not catch it: both foreground `uniqueMeshName` and the manager's funnel de-duplicate by
  // exact roster NAME, never by resolved channel. Found by fmae-rev-sec, reachability confirmed by
  // fmae-rev-eng and measured here.
  //
  // A name that is ALREADY channel-safe maps unchanged, so nothing that works today moves. Only a
  // name that the sanitiser would alter gains a short digest of the EXACT original — which is what
  // makes collisions negligible rather than impossible, since the digest distinguishes precisely
  // the inputs the sanitiser fused. NOT "injective" — that word appeared here in an earlier draft
  // and contradicted this comment's own heading four lines up. A truncated digest cannot be
  // injective, and one sentence claiming otherwise is all it takes for the next reader to believe
  // the stronger property. Rejecting unsafe names was the alternative and it is worse: it would break a naming
  // grammar the product documents as supported.
  // THE TWO NAMESPACES MUST BE DISJOINT, and an earlier version's were not.
  //
  // Hashing only when `safe !== name` left the hashed image set reachable from the UNHASHED side:
  // `"Worker"` maps to `events.worker-a67b04cd5c491d4d`, and `"worker-a67b04cd5c491d4d"` is itself a
  // perfectly valid already-safe name that mapped to the SAME channel. A deterministic,
  // constructible collision — nothing to do with digest length, and reachable by anyone who can read
  // the algorithm and choose their own agent name. Found by fmae-rev-test.
  //
  // So a name that merely LOOKS like an image is hashed too. Every hashed channel ends in exactly
  // one `-<16 hex>` more than its own preimage, so no unhashed name can land on a hashed image and
  // no hashed image can land on another. What remains is the digest bound, which is the honest
  // residual; the structural overlap is gone.
  // AND the disjointness argument above has a PRECONDITION that was left implicit and was false:
  // it assumes distinct names give distinct hash INPUTS. `createHash().update(string)` encodes UTF-8,
  // which replaces every unpaired surrogate with U+FFFD — so `"\uD800"`, `"\uD801"` and `"\uFFFD"`
  // hashed to ONE digest and shared one channel, and with it one publish grant and one event stream.
  // Deterministic and constructible, not the truncated-digest residual this comment claimed. Found by
  // fmae-rev-test with a broker-backed effect repro; confirmed by fmae-rev-eng and fmae-rev-wal.
  //
  // `assertValidName` now refuses such a name at the shared choke point, which also covers the launch
  // environment mangling the name on its way to a child. It is re-asserted HERE rather than assumed,
  // because this function derives an AUTHORIZATION value and must not depend on a caller having
  // validated first — the shipped rule is reused, never a second copy of it that could drift.
  assertValidName(name);
  const looksHashed = /-[0-9a-f]{16}$/.test(safe);
  return safe === name && !looksHashed
    ? `events.${safe}`
    : `events.${safe}-${createHash("sha256").update(name).digest("hex").slice(0, 16)}`;
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
