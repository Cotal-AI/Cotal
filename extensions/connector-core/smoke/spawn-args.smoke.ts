/**
 * cotal_spawn parity smoke — proves the MCP spawn door carries the same harness/model/variant/prompt knobs as the
 * operator's `cotal spawn --detach`. The `cotal_spawn` tool forwards to MeshAgent.spawn, which (1c.2b/2c)
 * puts `agent` plus model selectors into the manager's v0.4 `spawn` command over the generic invoke path
 * (`CotalEndpoint.invokeService`) in EVERY auth mode — the user-mode caller triple is the endpoint's own
 * bearer-derived principal + the launcher's lifecycle uid, so there is no ctl branch left. No NATS: the
 * MeshAgent constructor builds an endpoint but never connects, so we swap in a recording `ep` and mark
 * connected. Run with: pnpm smoke:spawn-args
 */
import { MeshAgent, SPAWN_TIMEOUT_MS } from "../src/agent.js";
import { cotalToolSpecs } from "../src/tool-specs.js";
import type { AgentConfig } from "../src/config.js";

let failures = 0;
function check(label: string, cond: boolean, extra?: unknown): void {
  console.log(`${cond ? "✓" : "✗"} ${label}${cond ? "" : ` — ${extra ?? ""}`}`);
  if (!cond) failures++;
}

const cfg: AgentConfig = {
  space: "smoke", name: "caller", servers: "nats://127.0.0.1:1", kind: "agent", tls: false,
  subscribe: [], allowSubscribe: [], allowPublish: [],
};
const a = new MeshAgent(cfg);

// Record the generic invoke instead of sending it; mark connected so assertConnected() passes.
type Recorded = { endpoint: string; command: string; args?: Record<string, unknown>; opts?: { target?: unknown; deadlineMs?: number } };
let rec: Recorded | undefined;
(a as unknown as {
  ep: {
    invokeService: (endpoint: string, command: string, args?: Record<string, unknown>, opts?: { target?: unknown; deadlineMs?: number }) => Promise<unknown>;
    principal: { owner: string; actor: string };
  };
}).ep = {
  invokeService: (endpoint, command, args, opts) => {
    rec = { endpoint, command, args, opts };
    return Promise.resolve({ reply: { ok: true, data: { name: args?.name } }, responder: { endpoint, instanceId: "i", epoch: 0 } });
  },
  principal: { owner: "local", actor: "caller" },
};
(a as unknown as { _connected: boolean })._connected = true;

// Full knobs: harness + model selectors + the kickoff prompt ride through to the manager's
// v0.4 `spawn` command. The prompt is what makes a fresh, never-prompted session take its first
// turn; a channel nudge reaches Claude but does not start that first turn on its own.
await a.spawn("rev", "reviewer", { agent: "opencode", model: "sonnet", variant: "high", prompt: "Review the current diff." });
check("command is the manager endpoint's `spawn`", rec?.endpoint === "manager" && rec?.command === "spawn", rec);
check("name forwarded", rec?.args?.name === "rev");
check("role forwarded", rec?.args?.role === "reviewer");
check("agent (harness) forwarded", rec?.args?.agent === "opencode", rec?.args?.agent);
check("model forwarded", rec?.args?.model === "sonnet", rec?.args?.model);
check("variant forwarded", rec?.args?.variant === "high", rec?.args?.variant);
check("kickoff prompt forwarded", rec?.args?.prompt === "Review the current diff.", rec?.args?.prompt);
// #159 B1: the manager replies to `spawn` only on a real outcome (join / exit / ~30s readiness
// backstop) — the request must carry the long spawn window, not fall back to the op default.
check("request outlives the readiness wait (SPAWN_TIMEOUT_MS, not the default deadline)", rec?.opts?.deadlineMs === SPAWN_TIMEOUT_MS, rec?.opts?.deadlineMs);

// Name-only: agent/model/variant absent → STRIPPED before the closed input contract validates
// (a present-but-undefined key would refuse at additionalProperties:false), so the manager
// applies its defaults (env/Claude, file model).
await a.spawn("plain");
check("name-only: agent key absent", !("agent" in (rec?.args ?? {})));
check("name-only: model key absent", !("model" in (rec?.args ?? {})));
check("name-only: variant key absent", !("variant" in (rec?.args ?? {})));
check("name-only: role key absent", !("role" in (rec?.args ?? {})));
check("name-only: prompt key absent", !("prompt" in (rec?.args ?? {})));

// The published cotal_spawn surface carries the prompt too — proving MeshAgent.spawn alone is not
// enough, because the live failure entered through the tool and that door omitted the field.
const spawnTool = cotalToolSpecs(cfg).find((s) => s.name === "cotal_spawn") as
  | { schema: { shape: Record<string, unknown> }; run: (agent: MeshAgent, config: AgentConfig, args: Record<string, unknown>) => Promise<unknown> }
  | undefined;
check("cotal_spawn schema exposes the kickoff prompt", spawnTool !== undefined && "prompt" in spawnTool.schema.shape);
await spawnTool?.run(a, cfg, { name: "tool-rev", prompt: "Start the review now." });
check("cotal_spawn tool forwards the kickoff prompt", rec?.args?.prompt === "Start the review now.", rec?.args?.prompt);

// USER MODE rides the SAME invokeService door (1c.2c: the endpoint's bearer-derived principal +
// the launcher's lifecycle uid ARE the caller triple; no ctl branch remains in the connector).
const u = new MeshAgent({ ...cfg, userAuth: { bearerCmd: ["true"], sentinelCreds: "sentinel", owner: "u_x", actor: "cli" } } as AgentConfig);
let recUser: Recorded | undefined;
(u as unknown as {
  ep: {
    invokeService: (endpoint: string, command: string, args?: Record<string, unknown>, opts?: { target?: unknown; deadlineMs?: number }) => Promise<unknown>;
    principal: { owner: string; actor: string };
  };
}).ep = {
  invokeService: (endpoint, command, args, opts) => {
    recUser = { endpoint, command, args, opts };
    return Promise.resolve({ reply: { ok: true, data: { name: args?.name } }, responder: { endpoint, instanceId: "i", epoch: 0 } });
  },
  principal: { owner: "u_x", actor: "cli" },
};
(u as unknown as { _connected: boolean })._connected = true;
await u.spawn("rev", "reviewer", { agent: "opencode", model: "sonnet" });
check("user mode: the SAME v0.4 spawn command over invokeService (no ctl branch left)",
  recUser?.endpoint === "manager" && recUser?.command === "spawn" && recUser?.args?.model === "sonnet", recUser);
check("user mode: request carries the readiness window too", recUser?.opts?.deadlineMs === SPAWN_TIMEOUT_MS, recUser?.opts?.deadlineMs);

console.log(`\nSPAWN-ARGS SMOKE ${failures === 0 ? "OK ✅" : "FAILED ❌"}`);
process.exit(failures === 0 ? 0 : 1);
