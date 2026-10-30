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
 *
 * An inline `persona` rides whole to the manager through a closed schema, and its `model` is audited
 * like the override. `cotal_persona` carries `capabilities` for the manager to bound.
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

// Channels on the peer door. `join` rides to the manager and is bounded HERE by the caller's read
// ACL, before anything is sent; the caller's own ACL rides as `callerAcl`, which the manager uses
// only for a persona that names no channel. A helper spawned from a seat on #general used to start
// on no channel with no way to say otherwise, and its first cotal_send was refused.
const reader: AgentConfig = { ...cfg, subscribe: ["general"], allowSubscribe: ["general", "review"], allowPublish: ["general"] };
check("cotal_spawn schema exposes join", spawnTool !== undefined && "join" in spawnTool.schema.shape);
const joinAgent = new MeshAgent(reader);
const callsJoin = record(joinAgent);
await spawnTool?.run(joinAgent, reader, { name: "helper", join: ["review"] });
check("cotal_spawn tool forwards join", JSON.stringify(spawnCall(callsJoin)?.args?.join) === JSON.stringify(["review"]), spawnCall(callsJoin)?.args);
check(
  "the spawn carries the caller's own ACL as callerAcl",
  JSON.stringify(spawnCall(callsJoin)?.args?.callerAcl) === JSON.stringify({ allowSubscribe: ["general", "review"], allowPublish: ["general"] }),
  spawnCall(callsJoin)?.args?.callerAcl,
);
const direct = new MeshAgent(reader);
const callsDirect = record(direct);
await direct.spawn("helper", undefined, { join: ["general"] });
check("MeshAgent.spawn forwards join", JSON.stringify(spawnCall(callsDirect)?.args?.join) === JSON.stringify(["general"]), spawnCall(callsDirect)?.args);
check("name-only join stays absent", spawnCall(callsA)?.args?.join === undefined, spawnCall(callsA)?.args);
const outside = new MeshAgent(reader);
const callsOutside = record(outside);
const outsideReply = await outside.spawn("helper", undefined, { join: ["ops"] });
check(
  "a join outside the caller's read ACL is refused before invoke",
  outsideReply.ok === false && /join: "ops" is not within your read ACL/.test(outsideReply.error ?? "") && callsOutside.length === 0,
  outsideReply,
);
const wild = new MeshAgent(reader);
const callsWild = record(wild);
const wildReply = await wild.spawn("helper", undefined, { join: ["team.>"] });
check("a wildcard join is refused before invoke", wildReply.ok === false && /concrete channel/.test(wildReply.error ?? "") && callsWild.length === 0, wildReply);

// The inline persona rides whole to the manager, which validates and bounds it as it does a file.
// The tool's schema is closed, so a field the record has no slot for (`config`, `owner`) is refused
// before anything is sent, and the persona body cannot be empty.
const personaShape = spawnTool?.schema.shape.persona as { safeParse: (value: unknown) => { success: boolean } } | undefined;
check("cotal_spawn schema exposes the inline persona", personaShape !== undefined);
check("the inline persona schema takes the documented record", personaShape?.safeParse({ prompt: "You review diffs.", role: "reviewer", allowPublish: [], capabilities: ["spawn"], save: true }).success === true);
check("the inline persona schema refuses a field it has no slot for", personaShape?.safeParse({ prompt: "x", config: "/etc/passwd" }).success === false && personaShape?.safeParse({ prompt: "x", owner: "u_x.someone" }).success === false);
check("the inline persona schema refuses an empty body", personaShape?.safeParse({ prompt: "" }).success === false);
const inline = { prompt: "You review diffs.", role: "reviewer", subscribe: ["general"], allowPublish: [], capabilities: ["spawn"] };
const inlineAgent = new MeshAgent(reader);
const callsInline = record(inlineAgent);
await spawnTool?.run(inlineAgent, reader, { name: "helper", persona: inline, prompt: "Review the diff." });
const recInline = spawnCall(callsInline);
check("cotal_spawn tool forwards the inline persona whole, beside its first-turn prompt",
  JSON.stringify(recInline?.args?.persona) === JSON.stringify(inline) && recInline?.args?.prompt === "Review the diff." && recInline?.args?.name === "helper", recInline?.args);
check("name-only persona stays absent", spawnCall(callsPlain)?.args?.persona === undefined, spawnCall(callsPlain)?.args);
const inlinePin = new MeshAgent(cfg);
const callsInlinePin = record(inlinePin);
const inlinePinReply = await inlinePin.spawn("helper", undefined, { persona: { prompt: "x", model: "grok-4.6" } });
check("an inline persona's model the manager did not record is refused like an override",
  inlinePinReply.ok === false && /requested model "grok-4.6"/.test(inlinePinReply.error ?? "") && callsInlinePin.some((c) => c.command === "inspect"), inlinePinReply);
check("the inline model is not sent again as a top-level override", !("model" in (spawnCall(callsInlinePin)?.args ?? {})), spawnCall(callsInlinePin)?.args);
// The record is forwarded as written, so the audit compares the manager's pin with the model as sent.
const paddedPin = new MeshAgent(cfg);
record(paddedPin, " grok-4.6 ");
const paddedReply = await paddedPin.spawn("helper", undefined, { persona: { prompt: "x", model: " grok-4.6 " } });
check("an inline model the manager recorded as sent is not reported as a dropped pin",
  paddedReply.ok === true && (paddedReply.data as { model?: string } | undefined)?.model === " grok-4.6 ", paddedReply);
const inlineLanded = new MeshAgent(cfg);
record(inlineLanded, "grok-4.6");
const landedReply = await inlineLanded.spawn("helper", undefined, { persona: { prompt: "x", model: "grok-4.6" } });
check("an inline model the manager recorded rides the spawn result", landedReply.ok === true && (landedReply.data as { model?: string } | undefined)?.model === "grok-4.6", landedReply);
const overrideAgent = new MeshAgent(cfg);
const callsOverride = record(overrideAgent, "sonnet");
const overrideReply = await overrideAgent.spawn("helper", undefined, { model: "sonnet", persona: { prompt: "x", model: "grok-4.6" } });
check("a top-level model wins over the inline one: both are sent, and the audit reads the top-level pin",
  overrideReply.ok === true && spawnCall(callsOverride)?.args?.model === "sonnet" && (spawnCall(callsOverride)?.args?.persona as { model?: string } | undefined)?.model === "grok-4.6", overrideReply);

// cotal_persona carries `capabilities` to the manager, which bounds them against the definer.
const personaTool = cotalToolSpecs(cfg).find((s) => s.name === "cotal_persona") as
  | { schema: { shape: Record<string, unknown> }; run: (agent: MeshAgent, config: AgentConfig, args: Record<string, unknown>) => Promise<{ text: string; isError?: boolean }> }
  | undefined;
check("cotal_persona schema exposes capabilities", personaTool !== undefined && "capabilities" in personaTool.schema.shape);
const definer = new MeshAgent(cfg);
const callsDefine = record(definer);
await personaTool?.run(definer, cfg, { name: "probe", prompt: "You probe.", capabilities: ["spawn"] });
const recDefine = callsDefine.find((c) => c.command === "define-persona");
check("cotal_persona forwards capabilities for the manager to bound", JSON.stringify(recDefine?.args?.capabilities) === JSON.stringify(["spawn"]), recDefine?.args);

const EXPECTED_CHECKS = 67;
if (checks !== EXPECTED_CHECKS) {
  failures++;
  console.log(`SUITE INCOMPLETE: ${checks} of ${EXPECTED_CHECKS} checks`);
}
console.log(`\nSPAWN-ARGS SMOKE ${failures === 0 ? "OK ✅" : "FAILED ❌"} — ${checks} checks, ${failures} failures`);
process.exit(failures === 0 ? 0 : 1);
