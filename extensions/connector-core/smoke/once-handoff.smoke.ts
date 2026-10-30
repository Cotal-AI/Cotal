/**
 * A `once` task's handoff, at the MeshAgent, over a scripted endpoint (the turn-intake pattern).
 *
 * A once task is handed to the harness at most once per seat process. An adapter claims it at its
 * dispatch site, confirms it on the harness's acceptance, or releases it when the dispatch fails;
 * a claim that outlives the handoff bound is sealed by its timer. A sealed task is reported to the
 * manager (`turn-unconfirmed`), and a report that never lands ends the seat's own process. Run
 * turns keep today's offer-again behavior. Timers are driven by intercepting `setTimeout`, so the
 * bounds run without waiting them out, except in the last cell: a seat in a process of its own
 * whose report never lands, which must exit with its shutdown stalled, in real time.
 *
 * Run: pnpm smoke:once-handoff
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mintLifecycleUid } from "@cotal-ai/core";
import { MeshAgent } from "../src/agent.js";
import { ONCE_EXIT_GRACE_MS, ONCE_HANDOFF_MS, exitOnceSeat, onceHandoffState, registerOnceExit } from "../src/once.js";
import type { AgentConfig } from "../src/config.js";
import type { MeshAgentOptions } from "../src/agent.js";

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
const rig = (uid = mintLifecycleUid(), options: MeshAgentOptions = {}) => {
  const a = new MeshAgent(config(uid), undefined, options);
  const state = {
    pending: [] as Row[],
    /** Answer every pull `stop`, as a manager that does not hold this seat does once its task ended. */
    stop: false,
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
      if (command === "turn-pending") return { reply: { ok: true, data: { turns: [...state.pending], notices: true, ...(state.stop ? { stop: true } : {}) } } };
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

console.log("\n4b. a seat whose wake it cannot confirm bounds an unclaimed pull");
{
  const bounded = rig(mintLifecycleUid(), { onceClaimBound: true });
  bounded.state.pending = [onceRow("o4b", "never dispatched")];
  const before = captured.length;
  await bounded.poll();
  check("the pull arms the bound", captured.length === before + 1);
  fireLast();
  await tick();
  check("a once task pulled and never claimed within the bound is sealed and reported",
    onceHandoffState(bounded.uid, "o4b") === "sealed" && bounded.state.reports.length === 1 && bounded.state.reports[0]!.goalId === "o4b", bounded.state.reports);
  const claimed = rig(mintLifecycleUid(), { onceClaimBound: true });
  claimed.state.pending = [onceRow("o4c", "dispatched in time")];
  await claimed.poll();
  const bound = captured.at(-1)!;
  claimed.a.claimTurns(["o4c"]);
  claimed.a.commitSurfacedTurns(["o4c"]);
  bound.fn();
  await tick();
  check("...and one handed over first is left as it is when the bound fires", onceHandoffState(claimed.uid, "o4c") === "confirmed" && claimed.state.reports.length === 0);
  const plain = rig();
  plain.state.pending = [onceRow("o4d", "a connector that confirms its wake")];
  const unbounded = captured.length;
  await plain.poll();
  check("a seat without the option arms no bound for a pull", captured.length === unbounded);
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

console.log("\n7b. a seat that cannot end itself declines its exit, keeps reporting, and is never forced out");
{
  // The process registry's exit latch, reset between cells: cell 7 left it set.
  const registry = (globalThis as unknown as Record<symbol, { exiting?: Promise<boolean> }>)[Symbol.for("cotal.once-handoff")]!;
  const graceTimers: number[] = [];
  const withGraceCaptured = async <T>(fn: () => Promise<T>): Promise<T> => {
    globalThis.setTimeout = ((f: () => void, ms?: number, ...rest: unknown[]) => {
      if (ms === ONCE_EXIT_GRACE_MS) { graceTimers.push(ms); return {} as ReturnType<typeof setTimeout>; }
      return realSetTimeout(f, ms, ...(rest as []));
    }) as typeof setTimeout;
    try { return await fn(); } finally { globalThis.setTimeout = realSetTimeout; }
  };
  const answers = async (exit: () => void | boolean | Promise<boolean>) => withGraceCaptured(async () => {
    registry.exiting = undefined;
    graceTimers.length = 0;
    registerOnceExit(exit);
    return { ending: await exitOnceSeat(), forced: graceTimers.length };
  });
  let asked = 0;
  const declined = await answers(() => { asked++; return false; });
  const again = await withGraceCaptured(() => exitOnceSeat());
  check("an exit that answers false declines: no forced exit is armed, and the next end asks the exit again",
    declined.ending === false && declined.forced === 0 && again === false && asked === 2 && graceTimers.length === 0, { declined, again, asked });
  const cases = {
    asyncFalse: await answers(async () => false),
    rejects: await answers(() => Promise.reject(new Error("could not read the parent"))),
    throws: await answers(() => { throw new Error("shutdown threw"); }),
    asyncTrue: await answers(async () => true),
    plain: await answers(() => {}),
  };
  check("a promise that answers false or rejects declines; a throw, true, or no answer ends the seat with its forced exit armed",
    cases.asyncFalse.ending === false && cases.asyncFalse.forced === 0 && cases.rejects.ending === false && cases.rejects.forced === 0
      && [cases.throws, cases.asyncTrue, cases.plain].every((c) => c.ending === true && c.forced === 1), cases);
  // A stop pull and a report's fallback can both end the seat while Claude's exit is still reading
  // the parent.
  let overlapAsked = 0;
  registry.exiting = undefined;
  graceTimers.length = 0;
  registerOnceExit(() => { overlapAsked++; return new Promise<boolean>((resolve) => realSetTimeout(() => resolve(false), 50)); });
  const overlap = await withGraceCaptured(() => Promise.all([exitOnceSeat(), exitOnceSeat()]));
  check("two ends that overlap share one exit: it is asked once, and its decline reaches both callers",
    overlap.every((ending) => ending === false) && overlapAsked === 1 && graceTimers.length === 0, { overlap, overlapAsked, forced: graceTimers.length });

  // The report loop on a fake clock: backoff waits run at once and advance it. The clock starts
  // after the claim, so every wait it sees is the loop's: the backoff cap and the forced exit's
  // grace are both 10 s, and its last wait is as long as the handoff bound. A forced exit armed
  // here would fire at once and show in `exits`.
  const loop = rig();
  loop.state.pending = [onceRow("o9", "z")];
  loop.state.unconfirmed = [...Array.from({ length: 30 }, () => ({ ok: false, code: "unavailable" })), { ok: true }];
  await loop.poll();
  loop.a.claimTurns(["o9"]);
  registry.exiting = undefined;
  let exitAsks = 0;
  registerOnceExit(() => { exitAsks++; return false; });
  const delays: number[] = [];
  const exits: number[] = [];
  const realExit = process.exit;
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    if (ms !== undefined && ms >= 1_000) { delays.push(ms); clock += ms; queueMicrotask(fn); return {} as ReturnType<typeof setTimeout>; }
    return realSetTimeout(fn, ms);
  }) as typeof setTimeout;
  (process as { exit: (code?: number) => never }).exit = ((code?: number) => { exits.push(code ?? 0); }) as (code?: number) => never;
  try {
    loop.a.releaseTurns(["o9"]);
    for (let i = 0; i < 400 && loop.state.reports.length < 31; i++) await new Promise((r) => setImmediate(r));
    for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
  } finally {
    Date.now = realNow;
    (process as { exit: typeof realExit }).exit = realExit;
    globalThis.setTimeout = realSetTimeout;
  }
  const atBound = delays.findIndex((_, i) => delays.slice(0, i + 1).reduce((x, y) => x + y, 0) > ONCE_HANDOFF_MS);
  check("past the bound the exit is asked once, declines, and the report goes on, waits growing to a minute and no longer",
    exitAsks === 1 && exits.length === 0 && atBound > 0 && loop.state.reports.length > atBound + 2
      && Math.max(...delays) === 60_000 && delays.slice(-3).every((d) => d === 60_000), { exitAsks, exits, delays, reports: loop.state.reports.length });
  check("...until a manager answers it: no report follows the answer", loop.state.reports.length === 31 && delays.length === 30, { reports: loop.state.reports.length, delays: delays.length });

  const stopping = rig();
  stopping.state.pending = [onceRow("o10", "w")];
  stopping.state.unconfirmed = Array.from({ length: 200 }, () => ({ ok: false, code: "unavailable" }));
  await stopping.poll();
  stopping.a.claimTurns(["o10"]);
  registry.exiting = undefined;
  registerOnceExit(() => false);
  let stopClock = realNow();
  Date.now = () => stopClock;
  let waits = 0;
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    if (ms !== undefined && ms >= 1_000) {
      waits++;
      stopClock += ms;
      // The agent stops while the loop waits past the bound.
      if (waits === 12) (stopping.a as unknown as { _stopping: boolean })._stopping = true;
      queueMicrotask(fn);
      return {} as ReturnType<typeof setTimeout>;
    }
    return realSetTimeout(fn, ms);
  }) as typeof setTimeout;
  try {
    stopping.a.releaseTurns(["o10"]);
    for (let i = 0; i < 300; i++) await new Promise((r) => setImmediate(r));
  } finally {
    Date.now = realNow;
    globalThis.setTimeout = realSetTimeout;
  }
  check("...and an agent that stops ends the loop with it", waits === 12 && stopping.state.reports.length === 13, { waits, reports: stopping.state.reports.length });

  const told = rig();
  told.state.stop = true;
  let stopAsks = 0;
  const first = await withGraceCaptured(async () => {
    registry.exiting = undefined;
    graceTimers.length = 0;
    registerOnceExit(() => { stopAsks++; return false; });
    await told.poll();
    await tick();
    await told.poll();
    await tick();
    return { asks: stopAsks, forced: graceTimers.length };
  });
  check("a pull answered `stop` asks the seat's exit; a declined one leaves the seat running, and the next `stop` asks again",
    first.asks === 2 && first.forced === 0, first);
  const ended = await withGraceCaptured(async () => {
    registry.exiting = undefined;
    graceTimers.length = 0;
    let graceful = 0;
    registerOnceExit(() => { graceful++; });
    await told.poll();
    await tick();
    return { graceful, forced: graceTimers.length };
  });
  check("...and an exit that does not decline ends the seat, with its forced exit armed", ended.graceful === 1 && ended.forced === 1, ended);

  // A seat holding no turn does not pull when it reconnects; the manager's repeated notice is what
  // reaches it.
  const idle = rig();
  let notice: (() => void) | undefined;
  (idle.a as unknown as { hasTurnRelay(): boolean }).hasTurnRelay = () => true;
  const idleEp = (idle.a as unknown as { ep: Record<string, unknown> }).ep;
  idleEp.tap = (fn: () => void) => { notice = fn; };
  idleEp.serviceRailCaller = () => ({ owner: "local", actor: "helper", uid: idle.uid });
  (idle.a as unknown as { armTurnRelay(): void }).armTurnRelay();
  await tick();
  idle.state.stop = true;
  registry.exiting = undefined;
  let idleAsks = 0;
  registerOnceExit(() => { idleAsks++; return false; });
  notice?.();
  await tick();
  check("a seat holding no turn pulls on the manager's notice, and the `stop` it gets asks its exit", notice !== undefined && idle.a.activeTurnCount() === 0 && idleAsks === 1, { armed: notice !== undefined, idleAsks });
  registry.exiting = undefined;
}

console.log("\n8. a seat whose report cannot land exits its own process, even while its shutdown stalls");
{
  const here = dirname(fileURLToPath(import.meta.url));
  // Node runs the script itself, so the pid the bound kills is the seat's own. The tsx CLI runs it
  // in a child of its own, which a SIGKILL to the CLI leaves running.
  const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
  const child = spawn(process.execPath, ["--import", tsx, join(here, "_once-exit-child.ts")], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout.on("data", (b) => { out += String(b); });
  child.stderr.on("data", (b) => { err += String(b); });
  const bound = ONCE_HANDOFF_MS + ONCE_EXIT_GRACE_MS + 30_000;
  const exit = await new Promise<{ code: number | null; at: number } | undefined>((r) => {
    const timer = setTimeout(() => r(undefined), bound);
    child.once("exit", (code) => { clearTimeout(timer); r({ code, at: Date.now() }); });
  });
  // A child the bound outlived is killed by its own pid, and the cell fails.
  if (exit === undefined) { try { process.kill(child.pid!, "SIGKILL"); } catch { /* already gone */ } }
  const graceful = Number(out.match(/GRACEFUL (\d+)/)?.[1]);
  const lapse = exit === undefined ? undefined : exit.at - graceful;
  check("its shutdown starts, and the process exits one grace period later with its teardown still holding the event loop",
    exit?.code === 1 && Number.isFinite(graceful) && lapse !== undefined && lapse >= ONCE_EXIT_GRACE_MS - 500 && lapse < ONCE_EXIT_GRACE_MS + 5_000,
    { exit, lapse, out, err: err.slice(-800) });
}
const EXPECTED_CELLS = 37;
console.log(`\n${fail === 0 && pass === EXPECTED_CELLS ? "ONCE HANDOFF SMOKE OK ✅" : "ONCE HANDOFF SMOKE FAILED"}  (${pass} passed, ${fail} failed)`);
if (pass + fail !== EXPECTED_CELLS) {
  console.log(`SUITE INCOMPLETE — ran ${pass + fail} of ${EXPECTED_CELLS} cells; a partial run is not a pass`);
  process.exit(1);
}
process.exit(fail === 0 ? 0 : 1);
