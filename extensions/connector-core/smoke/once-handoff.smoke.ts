/**
 * A `once` task's handoff, at the MeshAgent, over a scripted endpoint (the turn-intake pattern).
 *
 * A once task is handed to the harness at most once per seat process. An adapter claims it at its
 * dispatch site, confirms it on the harness's acceptance, or releases it when the dispatch fails;
 * a claim that outlives the handoff bound is sealed by its timer. A sealed task is reported to the
 * manager (`turn-unconfirmed`), and a report that never lands ends the seat's own process. Run
 * turns keep today's offer-again behavior. Timers are driven by intercepting `setTimeout`, so the
 * bounds run without waiting them out.
 *
 * Run: pnpm smoke:once-handoff
 */
import { mintLifecycleUid } from "@cotal-ai/core";
import { MeshAgent } from "../src/agent.js";
import { ONCE_HANDOFF_MS, onceHandoffState, registerOnceExit } from "../src/once.js";
import type { AgentConfig } from "../src/config.js";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};
const tick = () => new Promise((r) => setTimeout(r, 25));

type Row = { goalId: string; payload: string; acceptedAt: number; deadlineAt?: number; once?: true };

const config = (uid: string): AgentConfig => ({
  space: "smoke", name: "helper", servers: "nats://127.0.0.1:1", kind: "agent", tls: false,
  managerInstanceId: "m".repeat(26), lifecycleUid: uid,
  subscribe: [], allowSubscribe: [], allowPublish: [],
});

/** One agent over a scripted endpoint. `pending` is what `turn-pending` serves; `unconfirmed`
 *  scripts the answers to `turn-unconfirmed`, in order, and `reports` records each one sent. */
const rig = (uid = mintLifecycleUid()) => {
  const a = new MeshAgent(config(uid));
  const state = {
    pending: [] as Row[],
    yields: [] as Record<string, unknown>[],
    reports: [] as Record<string, unknown>[],
    unconfirmed: [] as Array<{ ok: boolean; code?: string }>,
  };
  (a as unknown as { ep: unknown }).ep = {
    principal: { owner: "local", actor: "helper" },
    setStatus: async () => {},
    setActivity: async () => {},
    setCondition: async () => {},
    invokeService: async (_ep: string, command: string, args: unknown) => {
      if (command === "turn-pending") return { reply: { ok: true, data: { turns: [...state.pending], notices: true } } };
      if (command === "turn-yield") {
        state.yields.push(args as Record<string, unknown>);
        state.pending = state.pending.filter((t) => t.goalId !== (args as { goalId?: string }).goalId);
        return { reply: { ok: true, data: { goalId: (args as { goalId?: string }).goalId, state: "succeeded" } } };
      }
      if (command === "turn-unconfirmed") {
        state.reports.push(args as Record<string, unknown>);
        const r = state.unconfirmed.shift() ?? { ok: true };
        return { reply: r.ok ? { ok: true, data: { goalId: (args as { goalId?: string }).goalId, state: "failed" } } : { ok: false, error: { code: r.code, message: `scripted ${r.code}` } } };
      }
      return { reply: { ok: false, error: { message: `unscripted command ${command}` } } };
    },
  };
  (a as unknown as { _connected: boolean })._connected = true;
  const poll = () => (a as unknown as { pollTurns(): Promise<void> }).pollTurns();
  return { a, uid, state, poll };
};
const onceRow = (goalId: string, prompt: string, deadlineAt?: number): Row => ({
  goalId, payload: JSON.stringify({ context: prompt, once: { spawner: "lead", ...(deadlineAt !== undefined ? { deadlineAt } : {}) } }),
  acceptedAt: Date.now(), ...(deadlineAt !== undefined ? { deadlineAt } : {}), once: true,
});
const runRow = (goalId: string): Row => ({ goalId, payload: JSON.stringify({ run: "r1", step: "/turn#0", context: "a run turn" }), acceptedAt: Date.now(), deadlineAt: Date.now() + 300_000 });
const boundary = async (a: MeshAgent) => { await a.setStatus("working"); await a.setStatus("idle"); await tick(); };

/** Run `fn` with every `setTimeout` of the handoff bound captured instead of armed. */
const captured: Array<{ fn: () => void; cleared: boolean }> = [];
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
  if (ms === ONCE_HANDOFF_MS) {
    const handle = { fn, cleared: false };
    captured.push(handle);
    return handle as unknown as ReturnType<typeof setTimeout>;
  }
  return realSetTimeout(fn, ms, ...(rest as []));
}) as typeof setTimeout;
globalThis.clearTimeout = ((h: unknown) => {
  const c = captured.find((x) => x === h);
  if (c) { c.cleared = true; return; }
  realClearTimeout(h as ReturnType<typeof setTimeout>);
}) as typeof clearTimeout;
const fireLast = () => { const c = captured.at(-1); if (c && !c.cleared) c.fn(); return c; };

console.log("1. a once task with no deadline is taken, rendered as one task, and offered until claimed");
{
  const { a, uid, state, poll } = rig();
  state.pending = [onceRow("o1", '{"context":"not this","ask":{}}')];
  await poll();
  const peek = a.peekPendingTurns();
  check("a once row with no deadline is accepted, not dropped as malformed", a.activeTurnCount() === 1);
  check("it is rendered as one task from its spawner, with the prompt as text and no deadline line",
    peek !== undefined && peek.goalIds.join() === "o1" && /lead started this seat for one task/.test(peek.text)
      && peek.text.includes('{"context":"not this","ask":{}}') && !/deadline/.test(peek.text) && /stopped when your turn ends/.test(peek.text), peek?.text);
  check("a peek is pure: it changes no handoff state, and a second peek returns the same", onceHandoffState(uid, "o1") === "pending" && a.peekPendingTurns()?.text === peek?.text);
  check("an unclaimed task wakes the seat", a.pendingWake() === 1);
}

console.log("\n2. the claim is a permit: two callers holding the same peek, and only one sends");
{
  const { a, uid, state, poll } = rig();
  state.pending = [onceRow("o2", "do it", Date.now() + 600_000)];
  await poll();
  const stale = a.peekPendingTurns()!;
  const first = a.claimTurns(stale.goalIds);
  const second = a.claimTurns(stale.goalIds);
  check("the first claim succeeds and the second, from the same stale peek, takes nothing", first === true && second === false && onceHandoffState(uid, "o2") === "claimed");
  check("a claimed task is offered by no peek and wakes nothing, so a held task drives no blank retry", a.peekPendingTurns() === undefined && a.pendingWake() === 0);
  a.commitSurfacedTurns(stale.goalIds);
  check("the harness's acceptance confirms it and stops its timer", onceHandoffState(uid, "o2") === "confirmed" && captured.at(-1)?.cleared === true);
  await boundary(a);
  check("the turn boundary yields it done, once", state.yields.length === 1 && state.yields[0]!.goalId === "o2" && state.yields[0]!.status === "done", state.yields);
  a.releaseTurns(stale.goalIds);
  await tick();
  check("a release after the confirmation does nothing", state.reports.length === 0 && onceHandoffState(uid, "o2") === "confirmed");
}

console.log("\n3. a dispatch given up on: the task is sealed, reported once, and never offered again");
{
  const { a, uid, state, poll } = rig();
  state.pending = [onceRow("o3", "maybe sent")];
  await poll();
  a.claimTurns(["o3"]);
  a.releaseTurns(["o3"]);
  a.releaseTurns(["o3"]);
  await tick();
  check("the release seals it and reports it to the manager once", onceHandoffState(uid, "o3") === "sealed" && state.reports.length === 1 && state.reports[0]!.goalId === "o3", state.reports);
  a.commitSurfacedTurns(["o3"]);
  await boundary(a);
  check("a late acceptance after the seal surfaces nothing, so no automatic yield follows", state.yields.length === 0);
  await poll();
  check("a later pull of the same task offers it to no one", a.peekPendingTurns() === undefined && a.pendingWake() === 0);
}

console.log("\n3b. a task its manager settles while it waits takes no permit from a stale peek");
{
  const { a, uid, state, poll } = rig();
  state.pending = [onceRow("o3b", "settled while queued")];
  await poll();
  const stale = a.peekPendingTurns()!;
  state.pending = [];
  await poll();
  check("the settle ends the handoff, and a dispatch queued behind a gate is refused its permit",
    onceHandoffState(uid, "o3b") === "sealed" && a.claimTurns(stale.goalIds) === false);
  await tick();
  check("...and nothing is reported: the manager already holds the task's terminal", state.reports.length === 0, state.reports);
}

console.log("\n4. the handoff timer measures the dispatch only");
{
  const { a, uid, state, poll } = rig();
  state.pending = [onceRow("o4", "slow to accept")];
  await poll();
  // A connected seat registers the timeout hook when it arms its relay.
  (a as unknown as { hasTurnRelay(): boolean }).hasTurnRelay = () => true;
  const ep = (a as unknown as { ep: Record<string, unknown> }).ep;
  ep.tap = () => {};
  ep.serviceRailCaller = () => ({ owner: "local", actor: "helper", uid });
  (a as unknown as { armTurnRelay(): void }).armTurnRelay();
  a.claimTurns(["o4"]);
  fireLast();
  await tick();
  check("a claim whose dispatch outlives the bound is sealed and reported by the timer", onceHandoffState(uid, "o4") === "sealed" && state.reports.length === 1, state.reports);
  const second = rig();
  second.state.pending = [onceRow("o5", "pi-style")];
  await second.poll();
  second.a.claimTurns(["o5"]);
  second.a.noteTurnsDispatched(["o5"]);
  const timer = captured.at(-1)!;
  check("noting the dispatch stops the timer, so a slow first response is never ended by it", timer.cleared === true && onceHandoffState(second.uid, "o5") === "claimed");
}

console.log("\n5. run turns keep today's behavior");
{
  const { a, uid, state, poll } = rig();
  state.pending = [runRow("r1")];
  await poll();
  check("a run turn needs no permit, and a claim of it changes nothing", a.claimTurns(["r1"]) === true && onceHandoffState(uid, "r1") === "pending" && a.peekPendingTurns()?.goalIds.join() === "r1");
  a.releaseTurns(["r1"]);
  await tick();
  check("a released run turn is not reported and is offered again", state.reports.length === 0 && a.peekPendingTurns()?.goalIds.join() === "r1");
}

console.log("\n6. the state is the process's: a rebuilt MeshAgent and a second module copy see it");
{
  const uid = mintLifecycleUid();
  const first = rig(uid);
  first.state.pending = [onceRow("o6", "handed over")];
  await first.poll();
  first.a.claimTurns(["o6"]);
  first.a.commitSurfacedTurns(["o6"]);
  const rebuilt = rig(uid);
  rebuilt.state.pending = [onceRow("o6", "handed over")];
  await rebuilt.poll();
  check("a MeshAgent built again for the same seat does not offer the task again", rebuilt.a.peekPendingTurns() === undefined && rebuilt.a.pendingWake() === 0);
  await boundary(rebuilt.a);
  check("...and still yields it at the boundary, because the session has it", rebuilt.state.yields.length === 1 && rebuilt.state.yields[0]!.goalId === "o6");
  const copy = await import(`../src/once.js?copy=${Date.now()}`) as typeof import("../src/once.js");
  check("a second copy of the module reads the same registry", copy.onceHandoffState !== onceHandoffState && copy.onceHandoffState(uid, "o6") === "confirmed");
}

console.log("\n7. the report: retried while the manager is unreachable, and a report that never lands ends the seat");
{
  const { a, state, poll } = rig();
  state.pending = [onceRow("o7", "x")];
  state.unconfirmed = [{ ok: false, code: "unavailable" }];
  await poll();
  a.claimTurns(["o7"]);
  a.releaseTurns(["o7"]);
  await new Promise((r) => realSetTimeout(r, 1_500));
  check("an unreachable manager is asked again until the report lands", state.reports.length === 2, state.reports);

  const stuck = rig();
  stuck.state.pending = [onceRow("o8", "y")];
  stuck.state.unconfirmed = Array.from({ length: 50 }, () => ({ ok: false, code: "unavailable" }));
  await stuck.poll();
  let graceful = 0;
  registerOnceExit(() => { graceful++; });
  const exits: number[] = [];
  const realExit = process.exit;
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  // Backoff waits and the forced exit run on the fake clock.
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    if (ms !== undefined && ms >= 1_000) { clock += ms; queueMicrotask(fn); return {} as ReturnType<typeof setTimeout>; }
    return realSetTimeout(fn, ms);
  }) as typeof setTimeout;
  (process as { exit: (code?: number) => never }).exit = ((code?: number) => { exits.push(code ?? 0); }) as (code?: number) => never;
  try {
    stuck.a.claimTurns(["o8"]);
    stuck.a.releaseTurns(["o8"]);
    for (let i = 0; i < 200 && exits.length === 0; i++) await new Promise((r) => setImmediate(r));
  } finally {
    Date.now = realNow;
    (process as { exit: typeof realExit }).exit = realExit;
  }
  check("a report that cannot land within the bound starts the seat's graceful shutdown and then exits its process",
    graceful === 1 && exits.length === 1 && exits[0] === 1 && stuck.state.reports.length > 1, { graceful, exits, reports: stuck.state.reports.length });
}

globalThis.setTimeout = realSetTimeout;
globalThis.clearTimeout = realClearTimeout;
const EXPECTED_CELLS = 23;
console.log(`\n${fail === 0 && pass === EXPECTED_CELLS ? "ONCE HANDOFF SMOKE OK ✅" : "ONCE HANDOFF SMOKE FAILED"}  (${pass} passed, ${fail} failed)`);
if (pass + fail !== EXPECTED_CELLS) {
  console.log(`SUITE INCOMPLETE — ran ${pass + fail} of ${EXPECTED_CELLS} cells; a partial run is not a pass`);
  process.exit(1);
}
process.exit(fail === 0 ? 0 : 1);
