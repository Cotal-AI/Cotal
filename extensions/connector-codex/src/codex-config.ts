/**
 * The `-c key=value` overrides the host passes to the codex child: the operator's launch options,
 * the model selectors, the autonomy defaults and the wiring to this host's cotal_* tools.
 */
import { MCP_SERVER_NAME, MCP_TOKEN_ENV, type CotalMcpEndpoint } from "./mcp.js";

/** The `-c key=value` override list for the codex child: the operator's launch options first
 *  (verbatim), then the selectors and autonomy defaults ONLY where the operator didn't set that
 *  key — one rail, so an explicit `--opt approval_policy=…` naturally wins. An asking
 *  approval_policy is answered on the agent's prompt desk, which a seat serves on every mesh mode.
 *  `askPermissions` launches the thread with {@link ASKING_THREAD} in place of the autonomy defaults.
 *  A service tier beside an operator `service_tier` is refused, as buildLaunch refuses it. */
export function configOverrides(model: string | undefined, variant: string | undefined, askPermissions: boolean, serviceTier: string | undefined): [string, string][] {
  const overrides: [string, string][] = [];
  const raw = process.env.COTAL_CODEX_CONFIG?.trim();
  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("COTAL_CODEX_CONFIG must be a JSON object of config-key → value");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("COTAL_CODEX_CONFIG must be a JSON object of config-key → value");
    for (const [k, v] of Object.entries(parsed)) overrides.push([k, String(v)]);
  }
  const has = (key: string): boolean => overrides.some(([k]) => k === key);
  if (model && !has("model")) overrides.push(["model", `"${model}"`]);
  if (variant && !has("model_reasoning_effort")) overrides.push(["model_reasoning_effort", `"${variant}"`]);
  if (serviceTier) {
    if (has("service_tier")) throw new Error('codex host: mode "fast" and launch option "service_tier" both set the service tier; set one, not both');
    overrides.push(["service_tier", `"${serviceTier}"`]);
  }
  if (askPermissions) refuseAskingConflicts(overrides);
  else pushAutonomy(overrides);
  // The connector OWNS the `mcp_servers.cotal.*` namespace — it is where this agent's own mesh
  // voice is wired up, not a tunable. A later `-c` wins in codex, so an operator key here would
  // be silently overridden; refuse instead, so a bad launch says so rather than half-applying.
  // The whole `mcp_servers` namespace, not just our dotted keys. A launch option cannot even
  // express a dotted key (the key grammar refuses `.`), so the reachable shape is a TOP-LEVEL
  // `mcp_servers` inline table — which would merge against ours and leave last-`-c`-wins to sort
  // out a half-applied result. Refuse the whole namespace instead, matching the loud refusal
  // tool-sharing already gets.
  const stolen = overrides.find(([k]) => k === "mcp_servers" || k.startsWith("mcp_servers."));
  if (stolen)
    throw new Error(
      `codex connector: ${stolen[0]} is reserved — mcp_servers is how this agent reaches the mesh and ` +
        `cannot be set through launch options. Tool-sharing (connectors.codex.mcpServers) is the ` +
        `supported way to add servers, and is not implemented yet.`,
    );
  return overrides;
}

/** Point the child at the cotal_* tools this host is serving (mcp.ts). Appended LAST, and codex
 *  resolves a repeated key to the last `-c`, so this is authoritative over anything else. */
export function mcpOverrides(mcp: CotalMcpEndpoint): [string, string][] {
  const p = `mcp_servers.${MCP_SERVER_NAME}`;
  return [
    [`${p}.url`, `"${mcp.url}"`],
    // By NAME, never by value: a token on argv is world-readable in the process table.
    [`${p}.bearer_token_env_var`, `"${MCP_TOKEN_ENV}"`],
    // Pre-approve this server's tools. Codex otherwise raises an elicitation ("Allow the cotal
    // MCP server to run tool X?") per call, which for a mesh-driven turn nobody is watching would
    // hang the turn forever. These are the agent's own mesh voice — the same surface every other
    // connector exposes ungated — so standing approval is the honest setting, not a loosening.
    [`${p}.default_tools_approval_mode`, '"approve"'],
  ];
}

/** The autonomy defaults for a launch that does not ask before Codex uses a tool. */
function pushAutonomy(overrides: [string, string][]): void {
  const has = (key: string): boolean => overrides.some(([k]) => k === key);
  const approval = overrides.find(([k]) => k === "approval_policy");
  if (!approval) overrides.push(["approval_policy", '"never"']);
  // `never` means never ASK, not never allow: the agent runs its commands, and what bounds it is
  // the sandbox below, not a prompt nobody would be there to answer.
  const sandbox = overrides.find(([k]) => k === "sandbox_mode");
  const sandboxMode = sandbox ? sandbox[1].replace(/"/g, "") : "workspace-write";
  if (!sandbox) overrides.push(["sandbox_mode", '"workspace-write"']);
  // ...and inside that sandbox, network ON. Codex defaults workspace-write to no network, which
  // silently breaks most real work an agent is asked to do (installing a dependency, pushing a
  // branch, calling an API) with a failure that reads as the task being impossible rather than
  // the sandbox saying no. Filesystem containment is the part worth keeping — a peer's message is
  // a REMOTE input that can make this agent run commands, so it should not be able to write
  // outside its workspace.
  //
  // Scoped to the mode it actually describes rather than emitted always and assumed inert: under
  // `read-only` or `danger-full-access` this key has nothing to say, and shipping it anyway would
  // put a network permission in the argv of a launch the operator deliberately tightened — a claim
  // about codex's precedence we would be making without proving it.
  if (sandboxMode === "workspace-write" && !has("sandbox_workspace_write"))
    overrides.push(["sandbox_workspace_write", "{network_access=true}"]);
}

/**
 * The thread settings of a launch that asks before Codex uses a tool: T3 Code's approval-required
 * mode, where Codex asks before any command it does not know to be safe and before every file
 * change. They ride `thread/start`, because codex 0.162 refuses `approval_policy = "untrusted"` in
 * config.
 */
export const ASKING_THREAD: Readonly<Record<string, unknown>> = { approvalPolicy: "untrusted", sandbox: "read-only", approvalsReviewer: "user" };

/** What a launch with `reasoningEvents` puts on every `turn/start`: the reasoning summary the
 *  operator's `model_reasoning_summary` names, else `auto`. Codex's model catalog can default
 *  summaries to none, and turn/start overrides the config, so T3 Code's own Codex provider sends
 *  this on each turn too. */
export function reasoningTurn(overrides: readonly (readonly [string, string])[]): { summary: string } {
  const set = overrides.find(([k]) => k === "model_reasoning_summary")?.[1];
  return { summary: set === undefined ? "auto" : set.replace(/^"(.*)"$/, "$1") };
}

/** An asking launch sets these itself, so a launch option that sets one is refused. */
const ASKING_KEYS = new Set(["approval_policy", "sandbox_mode", "approvals_reviewer"]);

/** Refuse an asking launch whose launch options set what it sets. */
function refuseAskingConflicts(overrides: [string, string][]): void {
  const set = overrides.find(([k]) => ASKING_KEYS.has(k));
  if (set) throw new Error(`codex connector: askPermissions sets ${set[0]} itself — remove it from the launch options`);
}
