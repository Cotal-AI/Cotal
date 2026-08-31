/**
 * cotal_spawn parity smoke — proves the MCP spawn door carries the same harness/model/variant/prompt knobs as the
 * operator's `cotal spawn --detach`. The `cotal_spawn` tool forwards to MeshAgent.spawn, which (1c.2b/2c)
 * puts `agent` plus model selectors into the manager's v0.4 `spawn` command over the generic invoke path
 * (`CotalEndpoint.invokeService`) in EVERY auth mode — the user-mode caller triple is the endpoint's own
 * bearer-derived principal + the launcher's lifecycle uid, so there is no ctl branch left. No NATS: the
 * MeshAgent constructor builds an endpoint but never connects, so we swap in a recording `ep` and mark
 * connected. Run with: pnpm smoke:spawn-args
 *
 * #972: a requested `model` that the manager does not record is a refusal, not a successful spawn on
 * the harness default. The mock inspect is the attestation; a spawn that never inspects cannot tell
 * a landed pin from a dropped one.
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

type Recorded = { endpoint: string; command: string; args?: Record<string, unknown>; opts?: { target?: unknown; deadlineMs?: number } };
type InvokeEp = {
  ep: {
    invokeService: (endpoint: string, command: string, args?: Record<string, unknown>, opts?: { target?: unknown; deadlineMs?: number }) => Promise<unknown>;
    principal: { owner: string; actor: string };
  };
};

function record(agent: MeshAgent, inspectModel?: string): Recorded[] {
  const calls: Recorded[] = [];
  (agent as unknown as InvokeEp).ep = {
    invokeService: (endpoint, command, args, opts) => {
      calls.push({ endpoint, command, args, opts });
      if (command === "inspect") {
        const data = inspectModel === undefined ? { name: args?.name } : { name: args?.name, model: inspectModel };
        return Promise.resolve({ reply: { ok: true, data }, responder: { endpoint, instanceId: "i", epoch: 0 } });
      }
      return Promise.resolve({ reply: { ok: true, data: { name: args?.name, mode: "pty" } }, responder: { endpoint, instanceId: "i", epoch: 0 } });
    },
    principal: { owner: "local", actor: "caller" },
  };
  (agent as unknown as { _connected: boolean })._connected = true;
  return calls;
}

function spawnCall(calls: Recorded[]): Recorded | undefined {
  return calls.find((c) => c.command === "spawn");
}

const a = new MeshAgent(cfg);
const callsA = record(a, "sonnet");

// Full knobs: harness + model selectors + the kickoff prompt ride through to the manager's
// v0.4 `spawn` command. The prompt is what makes a fresh, never-prompted session take its first
// turn; a channel nudge reaches Claude but does not start that first turn on its own.
const pinned = await a.spawn("rev", "reviewer", { agent: "opencode", model: "sonnet", variant: "high", prompt: "Review the current diff." });
const rec = spawnCall(callsA);
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
check("inspect attests the recorded pin", callsA.some((c) => c.command === "inspect" && c.args?.name === "rev"), callsA);
check("recorded model rides the spawn result", pinned.ok === true && (pinned.data as { model?: string } | undefined)?.model === "sonnet", pinned);

// Name-only: agent/model/variant absent → STRIPPED before the closed input contract validates
// (a present-but-undefined key would refuse at additionalProperties:false), so the manager
// applies its defaults (env/Claude, file model).
const plain = new MeshAgent(cfg);
const callsPlain = record(plain);
await plain.spawn("plain");
const recPlain = spawnCall(callsPlain);
check("name-only: agent key absent", !("agent" in (recPlain?.args ?? {})));
check("name-only: model key absent", !("model" in (recPlain?.args ?? {})));
check("name-only: variant key absent", !("variant" in (recPlain?.args ?? {})));
check("name-only: role key absent", !("role" in (recPlain?.args ?? {})));
check("name-only: prompt key absent", !("prompt" in (recPlain?.args ?? {})));
check("name-only: inspect is not required when no model was requested", !callsPlain.some((c) => c.command === "inspect"));

// The published cotal_spawn surface carries the prompt too — proving MeshAgent.spawn alone is not
// enough, because the live failure entered through the tool and that door omitted the field.
const spawnTool = cotalToolSpecs(cfg).find((s) => s.name === "cotal_spawn") as
  | { schema: { shape: Record<string, unknown> }; run: (agent: MeshAgent, config: AgentConfig, args: Record<string, unknown>) => Promise<{ text: string; isError?: boolean }> }
  | undefined;
check("cotal_spawn schema exposes the kickoff prompt", spawnTool !== undefined && "prompt" in spawnTool.schema.shape);
const toolAgent = new MeshAgent(cfg);
const callsTool = record(toolAgent);
await spawnTool?.run(toolAgent, cfg, { name: "tool-rev", prompt: "Start the review now." });
check("cotal_spawn tool forwards the kickoff prompt", spawnCall(callsTool)?.args?.prompt === "Start the review now.", spawnCall(callsTool)?.args?.prompt);

// USER MODE rides the SAME invokeService door (1c.2c: the endpoint's bearer-derived principal +
// the launcher's lifecycle uid ARE the caller triple; no ctl branch remains in the connector).
const u = new MeshAgent({ ...cfg, userAuth: { bearerCmd: ["true"], sentinelCreds: "sentinel", owner: "u_x", actor: "cli" } } as AgentConfig);
const callsUser = record(u, "sonnet");
(u as unknown as InvokeEp).ep.principal = { owner: "u_x", actor: "cli" };
const recUserReply = await u.spawn("rev", "reviewer", { agent: "opencode", model: "sonnet" });
const recUser = spawnCall(callsUser);
check("user mode: the SAME v0.4 spawn command over invokeService (no ctl branch left)",
  recUser?.endpoint === "manager" && recUser?.command === "spawn" && recUser?.args?.model === "sonnet", recUser);
check("user mode: request carries the readiness window too", recUser?.opts?.deadlineMs === SPAWN_TIMEOUT_MS, recUser?.opts?.deadlineMs);
check("user mode: recorded model rides the spawn result", recUserReply.ok === true && (recUserReply.data as { model?: string } | undefined)?.model === "sonnet", recUserReply);

// #972: a requested pin that inspect does not record is a refusal, not a successful default-model seat.
const dropped = new MeshAgent(cfg);
record(dropped);
const droppedReply = await dropped.spawn("rev", "reviewer", { model: "grok-4.6" });
check(
  "a requested model the manager did not record is refused",
  droppedReply.ok === false && /requested model "grok-4.6"/.test(droppedReply.error ?? "") && /no model pin/.test(droppedReply.error ?? ""),
  droppedReply,
);

const mismatched = new MeshAgent(cfg);
record(mismatched, "claude-opus-4.6");
const mismatchedReply = await mismatched.spawn("rev", "reviewer", { model: "grok-4.6" });
check(
  "a requested model that inspect records as a different pin is refused",
  mismatchedReply.ok === false && /requested model "grok-4.6"/.test(mismatchedReply.error ?? "") && /claude-opus-4.6/.test(mismatchedReply.error ?? ""),
  mismatchedReply,
);

const empty = await a.spawn("rev", "reviewer", { model: "   " });
check("an empty model string is refused before invoke", empty.ok === false && /model: must not be empty/.test(empty.error ?? ""), empty);

const named = new MeshAgent(cfg);
record(named, "grok-4.6");
const toolReply = await spawnTool?.run(named, cfg, { name: "rev", model: "grok-4.6" });
check(
  "cotal_spawn tool names the recorded model on success",
  toolReply?.isError !== true && /recorded model "grok-4.6"/.test(toolReply?.text ?? ""),
  toolReply,
);

console.log(`\nSPAWN-ARGS SMOKE ${failures === 0 ? "OK ✅" : "FAILED ❌"}`);
process.exit(failures === 0 ? 0 : 1);
