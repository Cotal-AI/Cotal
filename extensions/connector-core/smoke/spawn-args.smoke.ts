/**
 * cotal_spawn parity smoke — proves the MCP spawn door carries the same harness/model/variant/prompt knobs as the
 * operator's `cotal spawn --detach`. The `cotal_spawn` tool forwards to MeshAgent.spawn, which (1c.2b/2c)
 * puts `agent` plus model selectors into the manager's v0.4 `spawn` command. Static mode records the
 * generic `CotalEndpoint.invokeService` path. User mode records the command boundary to grade spawn
 * arguments and model attestation, not the borrowed credential or wire transport. No NATS: the
 * MeshAgent constructor builds an endpoint but never connects. User control dispatch and claim
 * parsing have separate cells in manager-invoke-verdict. Run with: pnpm smoke:spawn-args
 *
 * #972: a requested `model` that the manager does not record is a refusal, not a successful spawn on
 * the harness default. The mock inspect is the attestation; a spawn that never inspects cannot tell
 * a landed pin from a dropped one.
 *
 * A launch that stands while only its pin read fails is a partial outcome: the seat, its id, its
 * manager and runtime, the unaudited pin and `cotal ps --on <manager>`, in the text and in the
 * structured content the MCP renderer sends. A refusal there read as "nothing was spawned", and the
 * caller's retry started a second seat on the same work.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MeshAgent, SPAWN_TIMEOUT_MS } from "../src/agent.js";
import { cotalToolSpecs } from "../src/tool-specs.js";
import { registerCotalTools } from "../src/tools.js";
import type { AgentConfig } from "../src/config.js";
import { describeEndpoint, EpEnvelopeError, EP_UNANSWERED } from "@cotal-ai/core";

let failures = 0, checks = 0;
function check(label: string, cond: boolean, extra?: unknown): void {
  checks++;
  console.log(`${cond ? "✓" : "✗"} ${label}${cond ? "" : ` — ${extra ?? ""}`}`);
  if (!cond) failures++;
}

const cfg: AgentConfig = {
  space: "smoke", name: "caller", servers: "nats://127.0.0.1:1", kind: "agent", tls: false,
  subscribe: [], allowSubscribe: [], allowPublish: [],
};

type Recorded = { endpoint: string; command: string; args?: Record<string, unknown>; opts?: { target?: unknown; deadlineMs?: number; instanceId?: string } };
type InvokeEp = {
  ep: {
    invokeService: (endpoint: string, command: string, args?: Record<string, unknown>, opts?: { target?: unknown; deadlineMs?: number; instanceId?: string }) => Promise<unknown>;
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
const INSTANCE = "iiiiiiiiiiiiiiiiiiiiiiiiii";

// Full knobs: harness + model selectors + the kickoff prompt ride through to the manager's
// v0.4 `spawn` command. The prompt is what makes a fresh, never-prompted session take its first
// turn; a channel nudge reaches Claude but does not start that first turn on its own.
const pinned = await a.spawn("rev", "reviewer", { agent: "opencode", model: "sonnet", variant: "high", prompt: "Review the current diff.", instance: INSTANCE });
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
check("instance pin reaches invokeService and requests a pinned resolve", rec?.opts?.instanceId === INSTANCE, rec?.opts);
check("inspect attests the recorded pin", callsA.some((c) => c.command === "inspect" && c.args?.name === "rev"), callsA);
check("model attestation stays on the pinned manager", callsA.find((c) => c.command === "inspect")?.opts?.instanceId === INSTANCE, callsA);
check("recorded model rides the spawn result", pinned.ok === true && (pinned.data as { model?: string } | undefined)?.model === "sonnet", pinned);

// The boundary option above must select core's exact-instance describe rail. A minimal fake NATS
// connection records the real describeEndpoint publication and lets its short deadline expire.
let describedSubject = "";
let statusDone: (() => void) | undefined;
const statusStream = {
  [Symbol.asyncIterator]() { return this; },
  next: () => new Promise<IteratorResult<{ type: string; error?: unknown }>>((resolve) => { statusDone = () => resolve({ done: true, value: undefined }); }),
  stop: () => statusDone?.(),
};
const routeProbe = {
  status: () => statusStream,
  subscribe: () => ({ unsubscribe() {} }),
  publish: (subject: string) => { describedSubject = subject; },
} as unknown as Parameters<typeof describeEndpoint>[0];
await describeEndpoint(routeProbe, "smoke", "manager", { owner: "local", actor: "caller", uid: "uuuuuuuuuuuuuuuuuuuuuuuuuu" }, { instanceId: INSTANCE, deadlineMs: 1 }).catch(() => undefined);
check("core resolve pin publishes describe on the exact manager instance rail", describedSubject.includes(`.ep.inst.manager.${INSTANCE}.describe.`), describedSubject);

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
check("name-only: invokeService stays unpinned", recPlain?.opts?.instanceId === undefined, recPlain?.opts);
check("name-only: inspect is not required when no model was requested", !callsPlain.some((c) => c.command === "inspect"));

// The published cotal_spawn surface carries the prompt too — proving MeshAgent.spawn alone is not
// enough, because the live failure entered through the tool and that door omitted the field.
const spawnTool = cotalToolSpecs(cfg).find((s) => s.name === "cotal_spawn") as
  | { schema: { shape: Record<string, unknown> }; run: (agent: MeshAgent, config: AgentConfig, args: Record<string, unknown>) => Promise<{ text: string; isError?: boolean }> }
  | undefined;
check("cotal_spawn schema exposes the kickoff prompt", spawnTool !== undefined && "prompt" in spawnTool.schema.shape);
check("cotal_spawn schema exposes the manager instance pin", spawnTool !== undefined && "instance" in spawnTool.schema.shape);
check("cotal_spawn schema exposes the seat runtime", spawnTool !== undefined && "runtime" in spawnTool.schema.shape);
const toolAgent = new MeshAgent(cfg);
const callsTool = record(toolAgent);
await spawnTool?.run(toolAgent, cfg, { name: "tool-rev", prompt: "Start the review now." });
check("cotal_spawn tool forwards the kickoff prompt", spawnCall(callsTool)?.args?.prompt === "Start the review now.", spawnCall(callsTool)?.args?.prompt);

const pinToolAgent = new MeshAgent(cfg);
const callsPinTool = record(pinToolAgent);
await spawnTool?.run(pinToolAgent, cfg, { name: "tool-pin", instance: INSTANCE });
check("cotal_spawn tool forwards the manager instance pin", spawnCall(callsPinTool)?.opts?.instanceId === INSTANCE, spawnCall(callsPinTool)?.opts);

const runtimeAgent = new MeshAgent(cfg);
const callsRuntime = record(runtimeAgent);
await spawnTool?.run(runtimeAgent, cfg, { name: "tool-runtime", runtime: "tmux" });
check("cotal_spawn tool forwards the seat runtime", spawnCall(callsRuntime)?.args?.runtime === "tmux", spawnCall(callsRuntime)?.args);
check("name-only runtime stays absent", !("runtime" in (recPlain?.args ?? {})));
const blankRuntime = spawnTool?.schema.shape.runtime as { safeParse: (value: unknown) => { success: boolean } } | undefined;
check("cotal_spawn schema refuses a blank runtime", blankRuntime?.safeParse("  ").success === false, blankRuntime?.safeParse("  "));

const malformedAgent = new MeshAgent(cfg);
const callsMalformed = record(malformedAgent);
const malformedReply = await spawnTool?.run(malformedAgent, cfg, { name: "bad-pin", instance: "not.a.lifecycle.token" });
check(
  "a malformed instance is refused before invoke",
  malformedReply?.isError === true && /instance .* is not a valid lifecycle token/.test(malformedReply.text) && callsMalformed.length === 0,
  { reply: malformedReply, calls: callsMalformed },
);

// User mode now borrows instance-bound control authority instead of using invokeService.
// Record the command boundary here: these cells grade the real spawn/inspect composition only.
// They do not pretend a recording endpoint exercises the user credential exchange or broker.
const u = new MeshAgent({ ...cfg, userAuth: { bearerCmd: ["not-executed"], sentinelCreds: "sentinel", owner: "u_x", actor: "cli" } } as AgentConfig);
const callsUser: Omit<Recorded, "endpoint">[] = [];
(u as unknown as { managerInvoke: (command: string, args?: Record<string, unknown>, opts?: Recorded["opts"]) => Promise<unknown> }).managerInvoke = async (command, args, opts) => {
  callsUser.push({ command, args, opts });
  return { ok: true, data: command === "inspect" ? { name: args?.name, model: "sonnet" } : { name: args?.name, mode: "pty" } };
};
(u as unknown as { _connected: boolean })._connected = true;
const recUserReply = await u.spawn("rev", "reviewer", { agent: "opencode", model: "sonnet" });
const recUser = callsUser.find((call) => call.command === "spawn");
check("user mode: spawn forwards harness and model at the command boundary",
  recUser?.args?.agent === "opencode" && recUser?.args?.model === "sonnet", recUser);
check("user mode: request carries the readiness window too", recUser?.opts?.deadlineMs === SPAWN_TIMEOUT_MS, recUser?.opts?.deadlineMs);
check("user mode: recorded model rides the spawn result", callsUser.some((call) => call.command === "inspect" && call.args?.name === "rev") && recUserReply.ok === true && (recUserReply.data as { model?: string } | undefined)?.model === "sonnet", recUserReply);

const authority = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const explicit = "bbbbbbbbbbbbbbbbbbbbbbbbbb";
const disagreeing = new MeshAgent({ ...cfg, managerInstanceId: authority, userAuth: { bearerCmd: ["not-executed"], sentinelCreds: "sentinel", owner: "u_x", actor: "cli" } } as AgentConfig);
const callsDisagreeing: Omit<Recorded, "endpoint">[] = [];
(disagreeing as unknown as { managerInvoke: (command: string, args?: Record<string, unknown>, opts?: Recorded["opts"]) => Promise<unknown> }).managerInvoke = async (command, args, opts) => {
  callsDisagreeing.push({ command, args, opts });
  return { ok: true, data: { name: args?.name, mode: "pty" } };
};
(disagreeing as unknown as { _connected: boolean })._connected = true;
const disagreementReply = await disagreeing.spawn("rev", undefined, { instance: explicit });
check(
  "user mode: an explicit instance that differs from credential authority is refused before invoke",
  disagreementReply.ok === false && /differs from this credential's instance authority/.test(disagreementReply.error ?? "") && callsDisagreeing.length === 0,
  { reply: disagreementReply, calls: callsDisagreeing },
);

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

// A launch that stands with only its pin read failed. Static mode, so the real managerInvoke turns
// each thrown failure into the reply the audit reads, and the answering manager rides the reply.
const MANAGER = "mmmmmmmmmmmmmmmmmmmmmmmmmm";
const PIN = "grok-4.6";
const launched = { ok: true, data: { name: "rev", id: "u_x.rev", agent: "claude", mode: "orca", lifecycleUid: "llllllllllllllllllllllllll" } };
type Structured = {
  status?: string; name?: string; id?: string; manager?: string; runtime?: string; joined?: boolean; next?: string; message?: string;
  model?: { requested?: string; audited?: boolean; reported?: boolean; error?: string };
};
type Result = { text: string; isError?: boolean; structured?: Structured };

/** `spawn` answers `spawned` from MANAGER; `inspect` throws `failure`. */
function auditFails(agent: MeshAgent, failure: unknown, spawned: Record<string, unknown> = launched): MeshAgent {
  (agent as unknown as InvokeEp).ep = {
    invokeService: (endpoint, command) => command === "inspect"
      ? Promise.reject(failure)
      : Promise.resolve({ reply: spawned, responder: { endpoint, instanceId: MANAGER, epoch: 0 } }),
    principal: { owner: "local", actor: "caller" },
  };
  (agent as unknown as { _connected: boolean })._connected = true;
  return agent;
}
const spawnWith = async (failure: unknown, spawned?: Record<string, unknown>) =>
  await spawnTool!.run(auditFails(new MeshAgent(cfg), failure, spawned), cfg, { name: "rev", model: PIN }) as Result;
const silence = new EpEnvelopeError("deadline-exceeded", "no reply to manager.inspect within the 10000ms budget (SPEC 13.5)", [{ kind: EP_UNANSWERED, endpoint: "manager", command: "inspect" }]);

// The hosted failure: the pin read's own connection timed out, and the transport said only "timeout".
const timedOut = await auditFails(new MeshAgent(cfg), new Error("timeout")).spawn("rev", "reviewer", { model: PIN });
const timedOutData = timedOut.data as { model?: string; pinAudit?: { requested?: string; error?: string; unreported?: true } } | undefined;
check(
  "a launch whose pin read timed out stands, with the failed audit beside it and no pin in its place",
  timedOut.ok === true && timedOutData?.pinAudit?.requested === PIN && timedOutData.pinAudit.error === "timeout" && timedOutData.pinAudit.unreported === undefined && timedOutData.model === undefined,
  timedOut,
);

const partial = await spawnWith(new Error("timeout"));
check(
  "cotal_spawn reports it as a partial outcome naming the seat, its id, manager and runtime, and the next step",
  partial.isError !== true && !/Couldn't spawn/.test(partial.text) && /it joined the mesh/.test(partial.text) && partial.text.includes("(id u_x.rev, manager " + MANAGER + ", runtime orca)")
    && partial.text.includes(`model pin "${PIN}" could not be audited (timeout)`) && /Do not spawn it again/.test(partial.text) && partial.text.includes("Next: `cotal ps --on " + MANAGER + "`"),
  partial,
);
const st = partial.structured;
check(
  "the partial's structured payload carries the same facts and the whole message",
  st?.status === "partial" && st.name === "rev" && st.id === "u_x.rev" && st.manager === MANAGER && st.runtime === "orca" && st.joined === true
    && st.model?.requested === PIN && st.model.audited === false && st.model.reported === true && st.model.error === "timeout"
    && st.next === `cotal ps --on ${MANAGER}` && st.message === partial.text,
  st,
);

const silent = await spawnWith(silence);
check(
  "a manager that did not answer the pin read within its budget leaves the pin unaudited",
  silent.isError !== true && /could not be audited \(no reply to manager\.inspect within the 10000ms budget/.test(silent.text) && silent.structured?.model?.reported === true,
  silent,
);

const unserved = await spawnWith(new EpEnvelopeError("not-found", `command "inspect" is not in manager's visible surface; describe lists spawn`));
check(
  "a manager with no inspect for this caller did not report the pin, and the result says so",
  unserved.isError !== true && unserved.text.includes(`model pin "${PIN}" was not reported by this manager (not-found: command "inspect"`) && unserved.structured?.model?.reported === false,
  unserved,
);

const unanswered = await spawnWith(new EpEnvelopeError("unavailable", "no responder for manager.inspect (SPEC 13.5)", [{ kind: EP_UNANSWERED, endpoint: "manager", command: "inspect" }], "not-executed"));
check(
  "a pin read no responder took is not reported by this manager either",
  unanswered.isError !== true && /was not reported by this manager/.test(unanswered.text) && unanswered.structured?.model?.reported === false,
  unanswered,
);

const accepted = { name: "rev", owner: "u_x", actor: "rev", uid: "uuuuuuuuuuuuuuuuuuuuuuuuuu", goalId: "g", fingerprint: "f", executor: { lifecycleUid: MANAGER, epoch: 0 } };
const booting = await spawnWith(new Error("timeout"), { id: "g", ok: false, error: { code: "uncertain", message: "rev did not join within its readiness window" }, data: accepted });
check(
  "a launch still booting with its pin unaudited is the same partial, marked as not joined",
  booting.isError !== true && /has not joined the mesh within its readiness window/.test(booting.text) && booting.text.includes(`(id rev, manager ${MANAGER})`)
    && booting.structured?.joined === false && booting.structured.manager === MANAGER && !("runtime" in booting.structured),
  booting,
);

const refused = await spawnWith(new Error("timeout"), { id: "g", ok: false, error: { code: "failed-precondition", message: `no persona "rev"` } });
check(
  "a launch the manager refused keeps the refusal shape even when the pin read also fails",
  refused.isError === true && /^Couldn't spawn rev: no persona "rev"/.test(refused.text) && refused.structured === undefined,
  refused,
);
check("a spawn whose pin was audited carries no structured payload", toolReply?.isError !== true && (toolReply as Result | undefined)?.structured === undefined, toolReply);

// The Claude Code renderer: hosts that show structured content see the partial there.
const mcp = new McpServer({ name: "spawn-args", version: "0.0.0" });
registerCotalTools(mcp, auditFails(new MeshAgent(cfg), new Error("timeout")), cfg, "smoke");
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "spawn-args-client", version: "0.0.0" });
await Promise.all([client.connect(clientTransport), mcp.connect(serverTransport)]);
const viaMcp = await client.callTool({ name: "cotal_spawn", arguments: { name: "rev", model: PIN } });
const mcpStructured = viaMcp.structuredContent as Structured | undefined;
const mcpText = viaMcp.content as Array<{ type: string; text: string }>;
check(
  "the MCP renderer sends the partial as structured content, with its JSON as text too",
  viaMcp.isError !== true && mcpStructured?.status === "partial" && mcpStructured.message === mcpText[0]?.text && mcpText[1]?.text === JSON.stringify(mcpStructured),
  viaMcp,
);
await client.close();

const EXPECTED_CHECKS = 47;
if (checks !== EXPECTED_CHECKS) {
  failures++;
  console.log(`SUITE INCOMPLETE: ${checks} of ${EXPECTED_CHECKS} checks`);
}
console.log(`\nSPAWN-ARGS SMOKE ${failures === 0 ? "OK ✅" : "FAILED ❌"} — ${checks} checks, ${failures} failures`);
process.exit(failures === 0 ? 0 : 1);
