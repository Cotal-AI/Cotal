/**
 * cotal_spawn parity smoke — proves the MCP spawn door carries the same harness/model knobs as the
 * operator's `cotal spawn --detach`. The `cotal_spawn` tool forwards to MeshAgent.spawn, which puts `agent`
 * and `model` into the manager's `start` control op; the manager's opStart already consumes both.
 * No NATS: the MeshAgent constructor builds an endpoint but never connects, so we swap in a
 * recording `ep` and mark connected. Run with: pnpm smoke:spawn-args
 */
import { MeshAgent, SPAWN_TIMEOUT_MS } from "../src/agent.js";
import type { AgentConfig } from "../src/config.js";
import { CONTROL_PRIVILEGED, type ControlReply, type ControlRequest, type ControlTier } from "@cotal-ai/core";

let failures = 0;
function check(label: string, cond: boolean, extra?: unknown): void {
  console.log(`${cond ? "✓" : "✗"} ${label}${cond ? "" : ` — ${extra ?? ""}`}`);
  if (!cond) failures++;
}

const cfg: AgentConfig = {
  space: "smoke", name: "caller", servers: "nats://127.0.0.1:1",
  subscribe: [], allowSubscribe: [], allowPublish: [],
};
const a = new MeshAgent(cfg);

// Record the control request instead of sending it; mark connected so assertConnected() passes.
let rec: { tier: ControlTier; req: ControlRequest; timeoutMs?: number } | undefined;
(a as unknown as { ep: { requestControl: (t: ControlTier, r: ControlRequest, ms?: number) => Promise<ControlReply> } }).ep = {
  requestControl: (tier, req, timeoutMs) => { rec = { tier, req, timeoutMs }; return Promise.resolve({ ok: true, data: { name: req.args?.name } }); },
};
(a as unknown as { _connected: boolean })._connected = true;

// Full knobs: harness + model ride through to the manager's `start` op.
await a.spawn("rev", "reviewer", { agent: "opencode", model: "sonnet" });
check("op is start", rec?.req.op === "start", rec?.req.op);
check("rides the privileged control subject", rec?.tier === CONTROL_PRIVILEGED);
check("name forwarded", rec?.req.args?.name === "rev");
check("role forwarded", rec?.req.args?.role === "reviewer");
check("agent (harness) forwarded", rec?.req.args?.agent === "opencode", rec?.req.args?.agent);
check("model forwarded", rec?.req.args?.model === "sonnet", rec?.req.args?.model);
// #159 B1: the manager replies to `start` only on a real outcome (join / exit / ~30s readiness
// backstop) — the request must carry the long spawn window, not fall back to the 5s op default.
check("request outlives the readiness wait (SPAWN_TIMEOUT_MS, not the 5s default)", rec?.timeoutMs === SPAWN_TIMEOUT_MS, rec?.timeoutMs);

// Name-only: agent/model absent → undefined, so the manager applies its defaults (env/Claude, file model).
await a.spawn("plain");
check("name-only: agent undefined", rec?.req.args?.agent === undefined);
check("name-only: model undefined", rec?.req.args?.model === undefined);
check("name-only: role undefined", rec?.req.args?.role === undefined);

console.log(`\nSPAWN-ARGS SMOKE ${failures === 0 ? "OK ✅" : "FAILED ❌"}`);
process.exit(failures === 0 ? 0 : 1);
