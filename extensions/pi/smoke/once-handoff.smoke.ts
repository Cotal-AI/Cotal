/**
 * A `once` task through the Pi driver, over a real MeshAgent whose endpoint is scripted.
 *
 * The driver claims a once task when it builds the batch that carries it, stops the handoff timer
 * when Pi starts that batch, and confirms the task on the provider's clean answer. A batch Pi does
 * not confirm, because it never started or its turn ended unclean, is held: its once task is sealed
 * and reported, and the automatic continuation does not send it again. The extension registers the
 * driver's shutdown as the exit a once seat takes when its report cannot land. With the session's
 * context cleared, that exit shuts down the next session Pi starts, and connector-core's forced exit
 * ends the process if none starts.
 *
 * Run: pnpm smoke:pi-once
 */
import { mintLifecycleUid } from "@cotal-ai/core";
import { MeshAgent, type AgentConfig } from "@cotal-ai/connector-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PiDriver, type CotalBatchDetails, type PiContextLike, type PiHost } from "../src/driver.js";
import cotalMesh from "../src/extension.js";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The handoff bound's timers, captured instead of armed, so a cell can see one cleared. */
const HANDOFF_MS = 60_000;
const captured: Array<{ cleared: boolean }> = [];
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
  if (ms !== HANDOFF_MS) return realSetTimeout(fn, ms, ...(rest as []));
  const handle = { cleared: false, unref() {} };
  captured.push(handle);
  return handle as unknown as ReturnType<typeof setTimeout>;
}) as typeof setTimeout;
globalThis.clearTimeout = ((h: unknown) => {
  const c = captured.find((x) => x === h);
  if (c) { c.cleared = true; return; }
  realClearTimeout(h as ReturnType<typeof setTimeout>);
}) as typeof clearTimeout;

const registry = () => (globalThis as Record<symbol, { handoffs: Map<string, { state: string }>; exit?: () => void }>)[Symbol.for("cotal.once-handoff")];
const stateOf = (uid: string, goalId: string) => registry()?.handoffs.get(`${uid}:${goalId}`)?.state ?? "pending";

/** A real MeshAgent over a scripted endpoint: `turn-pending` serves `pending`, `turn-unconfirmed`
 *  records each report. */
const rig = () => {
  const uid = mintLifecycleUid();
  const config: AgentConfig = {
    space: "smoke", name: "pi-once", servers: "nats://127.0.0.1:1", kind: "agent", tls: false,
    managerInstanceId: mintLifecycleUid(), lifecycleUid: uid, subscribe: [], allowSubscribe: [], allowPublish: [],
  };
  const mesh = new MeshAgent(config);
  const state = { pending: [] as object[], reports: [] as unknown[] };
  (mesh as unknown as { ep: unknown }).ep = {
    principal: { owner: "local", actor: "pi-once" },
    setStatus: async () => {},
    setActivity: async () => {},
    setCondition: async () => {},
    invokeService: async (_ep: string, command: string, args: { goalId?: string }) => {
      if (command === "turn-pending") return { reply: { ok: true, data: { turns: [...state.pending], notices: true } } };
      if (command === "turn-unconfirmed") {
        state.reports.push(args.goalId);
        return { reply: { ok: true, data: { goalId: args.goalId, state: "failed" } } };
      }
      return { reply: { ok: false, error: { message: `unscripted command ${command}` } } };
    },
  };
  (mesh as unknown as { _connected: boolean })._connected = true;
  const poll = () => (mesh as unknown as { pollTurns(): Promise<void> }).pollTurns();
  return { mesh, uid, state, poll };
};
const onceRow = (goalId: string, prompt: string) => ({
  goalId, payload: JSON.stringify({ context: prompt, once: { spawner: "lead" } }), acceptedAt: Date.now(), once: true,
});

class FakeHost implements PiHost {
  sent: Array<{ content: string; details: CotalBatchDetails }> = [];
  sendMessage(message: { content: string; details: CotalBatchDetails }): void {
    this.sent.push({ content: message.content, details: message.details });
  }
}
const context = (): PiContextLike & { shutdowns: number } => {
  const value = {
    shutdowns: 0, hasUI: false, ui: { notify() {} }, isIdle: () => true,
    shutdown() { value.shutdowns++; },
  };
  return value;
};
const start = (driver: PiDriver, details: CotalBatchDetails) =>
  driver.onMessageStart({ role: "custom", customType: "cotal-inbox", details });
const answer = (driver: PiDriver, details: CotalBatchDetails, status: number) => {
  driver.onContext([{ role: "custom", customType: "cotal-inbox", details }]);
  driver.onProviderResponse(status);
};

console.log("1. a once task is claimed into one batch and confirmed on the provider's clean answer");
{
  const { mesh, uid, state, poll } = rig();
  state.pending = [onceRow("p1", "summarize the incident")];
  await poll();
  const host = new FakeHost();
  const driver = new PiDriver(mesh, 200);
  driver.bind(host);
  driver.onSessionStart(context());
  const batch = host.sent[0];
  check("the batch carries the task", host.sent.length === 1 && batch!.content.includes("started this seat for one task") && batch!.content.includes("summarize the incident"), host.sent);
  check("building the batch claims the task", stateOf(uid, "p1") === "claimed", stateOf(uid, "p1"));
  start(driver, batch!.details);
  check("Pi starting the batch stops the handoff timer", captured.at(-1)?.cleared === true);
  answer(driver, batch!.details, 200);
  check("the provider's clean answer confirms the handoff", stateOf(uid, "p1") === "confirmed", stateOf(uid, "p1"));
  check("nothing was reported", state.reports.length === 0, state.reports);
}

console.log("\n2. an unclean turn end holds the batch: the task is sealed, reported, and not sent again");
{
  const { mesh, uid, state, poll } = rig();
  state.pending = [onceRow("p2", "fails mid-turn")];
  await poll();
  const host = new FakeHost();
  const ctx = context();
  const driver = new PiDriver(mesh, 200);
  driver.bind(host);
  driver.onSessionStart(ctx);
  driver.onAgentStart(ctx);
  start(driver, host.sent[0]!.details);
  driver.onAgentEnd([{ role: "assistant", stopReason: "error" }], ctx);
  await sleep(20);
  check("the held batch's task is sealed", stateOf(uid, "p2") === "sealed", stateOf(uid, "p2"));
  check("...and reported to the manager once", state.reports.length === 1 && state.reports[0] === "p2", state.reports);
  await sleep(200);
  check("the automatic continuation does not send the batch again", host.sent.length === 1, host.sent.length);
  check("the driver stays held", driver.state === "held", driver.state);
}

console.log("\n3. a batch Pi never starts is held by its watchdog: the task is sealed and reported");
{
  const { mesh, uid, state, poll } = rig();
  state.pending = [onceRow("p3", "never started")];
  await poll();
  const host = new FakeHost();
  const driver = new PiDriver(mesh, 30);
  driver.bind(host);
  driver.onSessionStart(context());
  await sleep(100);
  check("the watchdog's hold seals the task and reports it", stateOf(uid, "p3") === "sealed" && state.reports.length === 1, { state: stateOf(uid, "p3"), reports: state.reports });
  answer(driver, host.sent[0]!.details, 200);
  check("a provider answer that arrives later confirms nothing", stateOf(uid, "p3") === "sealed", stateOf(uid, "p3"));
}

console.log("\n4. the extension registers the driver's shutdown as the once exit");
{
  const keys = Object.keys(process.env).filter((k) => k.startsWith("COTAL_"));
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, { COTAL_SPACE: "smoke", COTAL_NAME: "pi-exit", COTAL_SERVERS: "nats://127.0.0.1:1" });
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const api = {
    sendMessage() {}, registerMessageRenderer() {}, registerTool() {},
    on(name: string, fn: (event: unknown, ctx: unknown) => unknown) { handlers.set(name, fn); },
  } as unknown as ExtensionAPI;
  await cotalMesh(api);
  const ctx = {
    shutdowns: 0, hasUI: false, ui: { notify() {} }, isIdle: () => true,
    shutdown() { ctx.shutdowns++; },
    sessionManager: { getSessionId: () => "s1", getSessionFile: () => undefined },
  };
  await handlers.get("agent_start")!({}, ctx);
  registry()?.exit?.();
  check("calling it shuts the Pi session down", ctx.shutdowns === 1, ctx.shutdowns);
  await handlers.get("session_shutdown")!({ reason: "quit" }, ctx);
}

console.log("\n5. with the session's context cleared, the once exit shuts down the next session Pi starts");
{
  const keys = Object.keys(process.env).filter((k) => k.startsWith("COTAL_"));
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, { COTAL_SPACE: "smoke", COTAL_NAME: "pi-cleared", COTAL_SERVERS: "nats://127.0.0.1:1" });
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const api = {
    sendMessage() {}, registerMessageRenderer() {}, registerTool() {},
    on(name: string, fn: (event: unknown, ctx: unknown) => unknown) { handlers.set(name, fn); },
  } as unknown as ExtensionAPI;
  await cotalMesh(api);
  const session = (id: string) => {
    const ctx = {
      shutdowns: 0, hasUI: false, ui: { notify() {} }, isIdle: () => true,
      shutdown() { ctx.shutdowns++; },
      sessionManager: { getSessionId: () => id, getSessionFile: () => undefined },
    };
    return ctx;
  };
  const first = session("s1");
  await handlers.get("agent_start")!({}, first);
  await handlers.get("session_shutdown")!({ reason: "new" }, first);
  registry()?.exit?.();
  check("the cleared session is not shut down again", first.shutdowns === 0, first.shutdowns);
  const next = session("s2");
  await handlers.get("agent_start")!({}, next);
  check("the next session Pi starts is shut down", next.shutdowns === 1, next.shutdowns);
  await handlers.get("session_shutdown")!({ reason: "quit" }, next);
}

console.log(fail === 0 ? `\nPI ONCE SMOKE PASSED ✅ (${pass} checks)` : `\nPI ONCE SMOKE FAILED ❌ (${pass} passed, ${fail} failed)`);
console.log(`COTAL_SMOKE_SENTINEL cells=${pass + fail} passed=${pass} failed=${fail}`);
process.exit(fail === 0 ? 0 : 1);
