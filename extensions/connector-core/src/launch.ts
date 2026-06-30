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
import type { McpServerSpec } from "@cotal-ai/core";

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

/** The per-agent transcript-mirror channel — the convention now lives in `@cotal-ai/core` (shared by
 *  the manager + connectors). Re-exported here so the connectors' existing
 *  `import { transcriptChannel } from "@cotal-ai/connector-core"` keeps resolving. */
export { transcriptChannel } from "@cotal-ai/core";

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
