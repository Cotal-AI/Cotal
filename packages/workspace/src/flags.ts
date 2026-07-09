import type { FlagSpec } from "@cotal-ai/core";

/**
 * The shared flag vocabulary of the workstation layer. Commands spread these specs instead of
 * declaring their own copies, so the vocabulary cannot drift between commands; a command that
 * takes only a SUBSET (e.g. `spawn` foreground has no `--creds`) composes the individual specs.
 * Declared `as const` so `FlagValues<typeof …>` derives each command's values type — the cast
 * in `run` is compile-checked against exactly these specs.
 */
export const spaceFlag = { name: "space", type: "string", value: "<s>", description: "target space (default: the resolved mesh)" } as const satisfies FlagSpec;
export const serverFlag = { name: "server", type: "string", value: "<url>", description: "broker URL (overrides the mesh registry entry)" } as const satisfies FlagSpec;
export const credsFlag = { name: "creds", type: "string", value: "<path>", description: "creds file for an off-registry connection" } as const satisfies FlagSpec;

/** The mesh-target bundle: which space, which broker, and (off-registry) which credential.
 *  Resolution order is `resolveMeshTarget`'s: explicit flags > the folder's project > the
 *  registry/`current` mesh. */
export const targetFlags = [spaceFlag, serverFlag, credsFlag] as const satisfies readonly FlagSpec[];

/**
 * The launch grammar: every knob for bringing an agent onto the mesh, shared verbatim by the
 * foreground and detached (`--detach`, manager-run) paths of `cotal spawn` — one bundle, so the
 * two launch modes can never again diverge in ability (the old `spawn` vs `start` drift).
 * The MCP `cotal_spawn` tool mirrors this grammar; a parity smoke (not an import — tier rule)
 * keeps it honest.
 */
export const launchFlags = [
  { name: "name", type: "string", value: "<n>", description: "presence name override; does not choose the persona" },
  { name: "config", type: "string", value: "<persona-or-path>", description: "persona catalog name or file path; defaults from COTAL_DEFAULT_PERSONA" },
  { name: "agent", type: "string", value: "<a>", description: "connector type (claude, opencode, hermes …); defaults from COTAL_DEFAULT_AGENT" },
  { name: "role", type: "string", value: "<r>", description: "role override (wins over the agent file's role:)" },
  { name: "model", type: "string", value: "<m>", description: "model override (wins over the agent file's model:)" },
  { name: "variant", type: "string", value: "<v>", description: "model variant override (connector-defined; wins over the agent file's variant:)" },
  { name: "opt", type: "string", multiple: true, value: "<k=v>", description: "connector-specific launch option (repeatable); wins per-key over the agent file's launchOptions:" },
  { name: "cwd", type: "string", value: "<dir>", description: "working directory to root the agent at" },
  { name: "prompt", type: "string", value: "<text>", description: "initial prompt auto-submitted at start" },
  { name: "resume", type: "string", value: "<id>", description: "fork an existing session id into the mesh (claude only; detached: pair with --cwd)" },
  { name: "transcript", type: "boolean", description: "mirror the session transcript to tr-<name>" },
  { name: "no-transcript", type: "boolean", description: "explicit default: no transcript mirror" },
  { name: "share-tools", type: "string", value: "<sel>", description: "share named operator MCP servers with the agent" },
  { name: "subscribe", type: "string", value: "<a,b>", description: "channel read set override" },
  { name: "allow-subscribe", type: "string", value: "<a,b>", description: "read ACL override" },
  { name: "allow-publish", type: "string", value: "<a,b>", description: "post ACL override" },
] as const satisfies readonly FlagSpec[];

/** Parse repeated `--opt key=value` pairs into the opaque launch-options map. The key is the text
 *  before the first `=`; the value is the remainder (may itself contain `=`). Fails loud on a
 *  missing `=`, an empty key, or a duplicate key — never silent last-wins. Values are strings (the
 *  CLI has no types); the consuming connector coerces. Returns undefined when there are none. */
export function parseLaunchOptions(pairs: string[] | undefined): Record<string, string> | undefined {
  if (!pairs?.length) return undefined;
  const out: Record<string, string> = {};
  for (const raw of pairs) {
    const eq = raw.indexOf("=");
    if (eq === -1) throw new Error(`--opt must be key=value (got "${raw}")`);
    const key = raw.slice(0, eq).trim();
    if (!key) throw new Error(`--opt has an empty key (got "${raw}")`);
    if (key in out) throw new Error(`--opt "${key}" given more than once`);
    out[key] = raw.slice(eq + 1);
  }
  return out;
}

/** Merge two opaque launch-option maps per key — `override` (e.g. a `--opt` flag) wins over `base`
 *  (e.g. the persona file's `launchOptions:`), mirroring how `--model`/`--variant` beat the file.
 *  Returns undefined when the result is empty, so an absent bag never becomes an empty object. */
export function mergeLaunchOptions(
  base: Record<string, unknown> | undefined,
  override: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!base && !override) return undefined;
  const merged = { ...base, ...override };
  return Object.keys(merged).length ? merged : undefined;
}
