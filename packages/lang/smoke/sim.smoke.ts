/**
 * The simulation handler's proof.
 *
 * The property that decides whether this is worth trusting is the negative one: an unscripted
 * effect must FAIL, loudly, with the step key and the script entry to add. A simulator that
 * invents a plausible turn result green-lights broken programs, which is worse than not having
 * one, so most of this suite is about what the simulator refuses to do.
 */
import { SimHandler, SimUnscriptedError } from "../src/sim.js";
import { EffectError, type EffectContext } from "../src/effects.js";
import { KeyScope, digest, requestId, type StepKey } from "../src/keys.js";

let pass = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) throw new Error(`FAIL: ${name}${extra !== undefined ? ` - ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ok ${name}`);
};

const bound: Record<string, unknown>[] = [];
// ⚠️ THIS DOUBLE WAS MISSING TWO FIELDS THE INTERPRETER ALWAYS SUPPLIES. `requestId` and
// `attempt` are not optional on `EffectContext`, so a handler reading either one saw `undefined`
// under these tests and a real value in production, the double and the thing it stands in for
// disagreeing with nothing to say so while the suite ran under tsx.
//
// `requestId` is derived through the PRODUCTION function rather than spelled here. An earlier
// revision wrote `${stepKeyString(key)}@${attempt}`, which is present, typed, and impossible: an
// endpoint id token is `[A-Za-z0-9_-]{1,64}` (see `keys.ts`, and `KEY_RESERVED_RE` names `/`, `#`
// and `:` as reserved), and that form carries all three plus `@`. Supplying a well-typed value the
// real system can never emit is the same defect as supplying none, wearing a better disguise.
const SIM_RUN_ID = "sim-run";
const SIM_INPUT_HASH = digest({ sim: true });
const ctxFor = (key: StepKey, attempt = 0): EffectContext => ({
  key,
  signal: { cancelled: false, onCancel: () => {} },
  requestId: requestId(SIM_RUN_ID, key, SIM_INPUT_HASH, attempt),
  attempt,
  bind: async (e) => {
    bound.push(e);
  },
});

// ---- 1) scripted turns, in occurrence order --------------------------------------------------

{
  const sim = new SimHandler({
    turns: { build: [{ status: "blocked", at: 0 }, { status: "done", at: 0 }] },
    clock: { start: 1_000_000, turn: "5m" },
  });
  const s = new KeyScope();
  const agent = { agent: "sim.builder", persona: "builder" };

  const r0 = await sim.turn({ agent }, ctxFor(s.nextEffect("turn", "build")));
  const r1 = await sim.turn({ agent }, ctxFor(s.nextEffect("turn", "build")));
  ok("occurrence 0 takes the first scripted result", r0.status === "blocked", r0);
  ok("occurrence 1 takes the second", r1.status === "done", r1);
  ok("virtual time advanced by one turn each", sim.now() === 1_000_000 + 2 * 300_000, sim.now());
  ok("each result is stamped with the virtual clock", r1.at === sim.now());
}

// ---- 2) an unscripted effect fails loudly -----------------------------------------------------

{
  const sim = new SimHandler({ turns: { build: { status: "done", at: 0 } } });
  const s = new KeyScope();
  let err: SimUnscriptedError | null = null;
  try {
    await sim.turn({ agent: { agent: "a", persona: "p" } }, ctxFor(s.nextEffect("turn", "verify")));
  } catch (e) {
    err = e as SimUnscriptedError;
  }
  ok("an unscripted step throws rather than inventing a result", err !== null);
  ok("the error carries the L6001 code", err?.code === "L6001", err?.code);
  ok("and names the step key", err?.stepKey === "/turn:verify#0", err?.stepKey);
  ok("and tells the author exactly what to add", err?.message.includes('{ turns: { "verify"') === true, err?.message);
}

// ---- 3) running past the end of a scripted list also fails --------------------------------------

{
  const sim = new SimHandler({ turns: { build: [{ status: "blocked", at: 0 }] } });
  const s = new KeyScope();
  await sim.turn({ agent: { agent: "a", persona: "p" } }, ctxFor(s.nextEffect("turn", "build")));
  let threw = false;
  try {
    await sim.turn({ agent: { agent: "a", persona: "p" } }, ctxFor(s.nextEffect("turn", "build")));
  } catch (e) {
    threw = (e as SimUnscriptedError).code === "L6001";
  }
  // A loop that runs one more iteration than the script covers is the most likely way a test
  // silently stops testing, so it has to be an error rather than a repeat of the last value.
  ok("a loop that outruns its script is an error, not a repeated last value", threw);
}

// ---- 4) sleeps are instant and honest ------------------------------------------------------------

{
  const sim = new SimHandler({ clock: { start: 0 } });
  const s = new KeyScope();
  const wall = Date.now();
  await sim.sleep({ duration: "4h" }, ctxFor(s.nextEffect("sleep")));
  ok("a four hour sleep takes no real time", Date.now() - wall < 1000);
  ok("but the virtual clock moves the full four hours", sim.now() === 4 * 3_600_000, sim.now());
  await sim.sleep({ duration: "2d" }, ctxFor(s.nextEffect("sleep")));
  ok("and durations accumulate", sim.now() === 4 * 3_600_000 + 2 * 86_400_000);
}

// ---- 5) injected checkpoint answers ---------------------------------------------------------------

{
  const sim = new SimHandler({
    checkpoints: { "approve-plan": { status: "resolved", value: true, by: "sim" } },
    clock: { start: 500 },
  });
  const s = new KeyScope();
  const r = await sim.checkpoint({ prompt: "ok?" }, ctxFor(s.nextEffect("checkpoint", "approve-plan")));
  // The handler reports WHAT HAPPENED, so the shape here is the raw outcome rather than the
  // program-facing result. This assertion changed with that contract, deliberately: a simulator
  // that returned the program's view would be deciding the disposition, which is the interpreter's
  // job and is what makes an edited onExpiry reapplyable at all.
  ok("a checkpoint answer is injected without a human", r.outcome === "resolved" && (r as { value?: unknown }).value === true, r);
}

// ---- 5b) `at` is stamped from virtual time on BOTH paths, whatever a script says ---------------
//
// `SimScript.checkpoints` refuses `at`, and the TYPE is the only thing that refuses it. A script
// whose type is inferred and then passed by name, a cast, or a parameter declared `unknown` all
// reach the handler with the field intact, and the three runtime consumers use exactly that last
// route. So the promise the type makes is a promise about the implementation, and until this cell
// existed nothing held the implementation to it: both return paths could start honouring a scripted
// `at` and every check in this package stayed green.
//
// `simFrom` takes `unknown` on purpose. It is the escape the prose names, written the way the real
// consumer writes it, so this cell drives the same route a caller can actually reach.
{
  const simFrom = (script: unknown) => new SimHandler(script as never);
  const scriptWith = (status: string, clock: { start: number; checkpoint: string }) => ({
    checkpoints: { gate: { status, value: true, at: 999_999 } },
    clock,
  });
  const MINUTE = 60_000;

  // The two paths run on DIFFERENT clocks, and each expectation is computed from its own fixture.
  // One fixture cannot tell "stamps virtual time" from "returns the constant that fixture happens to
  // produce": with both cells on `clock.start` 500 and the default 1m, a `checkpoint()` that ignored
  // the clock entirely and returned that fixture's own 60500 satisfied both and the suite stayed
  // green. Two clocks, neither of them the old one, and no constant satisfies both.
  // The returned VALUE is not the property either, and a second survivor proved it. An
  // implementation can compute the right number without moving the clock it claims to read:
  // `const at = this.virtualNow + parseDuration(...)` with no `advance` returns 181_500 while
  // `now()` stays at 1_500, and because the timebase is SHARED, every later sleep, turn or journal
  // stamp then starts from the stale time. Both cells stayed green under exactly that. So each one
  // reads the clock AFTER the call and requires it to have moved to where the stamp says it is.
  // A THIRD survivor, and the reason each cell now runs a prior effect. On a fresh handler making a
  // single call, `virtualNow` and `clock.start + clock.checkpoint` are the same number, so a
  // `checkpoint()` that RECOMPUTED the stamp from the script instead of reading the running clock
  // satisfied both the value and the `now()` check. It is wrong the moment anything moved the clock
  // first: with a 5m sleep ahead of it, the recomputation is short by the whole sleep. So each path
  // sleeps on its own handler first, which makes the running clock and the fixture arithmetic
  // disagree, and only the running clock gives the expected number.
  const resolvedSim = simFrom(scriptWith("resolved", { start: 1_500, checkpoint: "3m" }));
  await resolvedSim.sleep({ duration: "5m" }, ctxFor(new KeyScope().nextEffect("sleep", "warm")));
  const resolved = await resolvedSim
    .checkpoint({ prompt: "ok?" }, ctxFor(new KeyScope().nextEffect("checkpoint", "gate")));
  ok("a scripted `at` is discarded on the RESOLVED path, which stamps the shared clock it has moved",
    resolved.at === 1_500 + 5 * MINUTE + 3 * MINUTE && resolvedSim.now() === resolved.at, { ...resolved, now: resolvedSim.now() });

  const expiredSim = simFrom(scriptWith("expired", { start: 7_000, checkpoint: "2m" }));
  await expiredSim.sleep({ duration: "9m" }, ctxFor(new KeyScope().nextEffect("sleep", "warm")));
  const expired = await expiredSim
    .checkpoint({ prompt: "ok?" }, ctxFor(new KeyScope().nextEffect("checkpoint", "gate")));
  ok("a scripted `at` is discarded on the EXPIRED path too, which is the other return",
    expired.at === 7_000 + 9 * MINUTE + 2 * MINUTE && expiredSim.now() === expired.at, { ...expired, now: expiredSim.now() });
}

// ---- 6) a scripted timeout is a choice, and costs its full budget ------------------------------------

{
  const sim = new SimHandler({ events: { "await-build": [null] }, clock: { start: 0 } });
  const s = new KeyScope();
  const v = await sim.wait(
    { event: { event: "replied", agent: "b" }, timeout: "20m" },
    ctxFor(s.nextEffect("wait", "await-build")),
  );
  ok("a timed-out event resolves null rather than throwing", v === null);
  ok("and the clock moves by the whole timeout", sim.now() === 20 * 60_000, sim.now());
}

// ---- 7) fault injection ----------------------------------------------------------------------------

{
  // The adversarial cases the runtime has to survive: an agent dying at a specific occurrence.
  const sim = new SimHandler({
    turns: { build: [{ status: "done", at: 0 }, { status: "done", at: 0 }] },
    faults: [{ at: "turn:build#1", kind: "agent-down" }],
  });
  const s = new KeyScope();
  const agent = { agent: "a", persona: "p" };
  const r0 = await sim.turn({ agent }, ctxFor(s.nextEffect("turn", "build")));
  ok("the un-faulted occurrence runs normally", r0.status === "done");
  let err: EffectError | null = null;
  try {
    await sim.turn({ agent }, ctxFor(s.nextEffect("turn", "build")));
  } catch (e) {
    err = e as EffectError;
  }
  ok("the faulted occurrence throws", err !== null);
  ok("with the injected kind, so the program's catch can branch on it", err?.kind === "agent-down", err?.kind);
}

// ---- 8) spawn binds an external reference, so a crash mid-effect is recoverable -------------------------

{
  bound.length = 0;
  const sim = new SimHandler({});
  const s = new KeyScope();
  const h = await sim.spawn({ persona: "builder", worktree: "wt-1" }, ctxFor(s.nextEffect("spawn", "")));
  ok("spawn returns a stable, site-independent handle", h.agent === "sim.builder" && h.persona === "builder");
  ok("and it carries no host-local state", !("path" in h) && !("session" in h));
  // The VALUE, not the key: an earlier version asserted only that `simAgent` was present, and binding
  // the string "WRONG" under that key left every cell in this file green. Comparing it against the
  // handle the call RETURNED is what makes the journal fact and the returned reference the same
  // thing, which is the property crash recovery actually needs.
  ok("and the effect bound the agent it returned, before settling", bound.length === 1 && bound[0]?.simAgent === h.agent, bound);
  const h2 = await sim.spawn({ persona: "builder" }, ctxFor(s.nextEffect("spawn", "")));
  ok("a second spawn of the same persona is a distinct agent", h2.agent !== h.agent, h2.agent);
}

// ---- 8b) and so does every OTHER effect that binds, each with its own fact -----------------------------
//
// `spawn` was the only bound effect any cell read. A security review deleted `checkpoint`'s
// `await ctx.bind(...)` and all fifteen lang suites stayed green; the same deletion in `turn` (line
// 207) and in `ask` (line 214) is green too. So three durable external writes had nothing holding
// them to being written, and the effect they exist for is crash recovery: a settled effect whose
// binding never landed is replayed against state the journal cannot see.
//
// The bound STRING is the property, and so is WHEN it was bound. `turn` and `ask` bind `simGoal`
// and `checkpoint` binds `simCheckpoint`, so a checkpoint that bound the goal fact would be
// indistinguishable from a turn to anything reading the journal; and a fact bound after the effect
// has already moved the world is not the write crash recovery needs, it is a note about a write
// that already happened.
//
// The first version of this block asserted neither. It read the shared array after the await
// returned and asked only whether the right KEY was present, and both weaknesses were measured
// rather than argued: binding the literal "WRONG" under the right key in all three handlers left
// this file at 28 passed, and moving `turn`'s bind below its `advanceBy` left it at 28 passed too.
// An engineering review found both.
//
// The clock is what makes the order observable. Every handler binds, THEN advances, then stamps the
// advanced clock into what it returns, so a bind that really happened first sees the PRE-advance
// clock while a bind moved after the advance sees the post-advance one. Recording `sim.now()` at
// bind time turns "before settling" from a title into a comparison.
{
  const sim = new SimHandler({
    turns: { build: { status: "done", at: 0 } },
    asks: { q: 3 },
    checkpoints: { gate: { status: "resolved", value: true, by: "sim" } },
  });
  const s = new KeyScope();
  const agent = { agent: "a", persona: "p" };
  const seen: { fact: Record<string, unknown>; at: number }[] = [];
  const ctxAt = (key: StepKey): EffectContext => ({
    ...ctxFor(key),
    bind: async (e) => { seen.push({ fact: e, at: sim.now() }); },
  });

  const t0 = sim.now();
  await sim.turn({ agent }, ctxAt(s.nextEffect("turn", "build")));
  ok("a turn binds its goal fact, by value, before it advances the clock",
    seen.length === 1 && seen[0]?.fact.simGoal === "/turn:build#0" && seen[0]?.at === t0 && sim.now() > t0,
    { seen, t0, now: sim.now() });

  const t1 = sim.now();
  await sim.ask({ agent, schema: {} }, ctxAt(s.nextEffect("ask", "q")));
  ok("an ask binds its own goal fact the same way, and its own key",
    seen.length === 2 && seen[1]?.fact.simGoal === "/ask:q#0" && seen[1]?.at === t1 && sim.now() > t1,
    { seen, t1, now: sim.now() });

  const t2 = sim.now();
  await sim.checkpoint({ prompt: "ok?" }, ctxAt(s.nextEffect("checkpoint", "gate")));
  ok("a checkpoint binds its OWN fact, which is not the goal fact",
    seen.length === 3 && seen[2]?.fact.simCheckpoint === "/checkpoint:gate#0"
      && !("simGoal" in (seen[2]?.fact ?? {})) && seen[2]?.at === t2 && sim.now() > t2,
    { seen, t2, now: sim.now() });
}

// ---- 8c) and none of them SETTLES while its own bind is still in flight -------------------------
//
// 8b pins each bind's VALUE and its place against the clock. Neither survives as evidence that the
// effect WAITED for the bind, because both are invisible to a bind that resolves immediately: an
// effect that awaited it and one that fired it and walked away record the same fact at the same
// clock. Measured: turning `await ctx.bind(...)` into `void ctx.bind(...)` left all 28 cells above
// green. A real bind is a durable write, so an effect that settles while its own binding is still
// in flight is precisely the crash-recovery hole these cells exist to close: a crash in that gap
// loses the reference the record was supposed to make recoverable. The bind below therefore does
// NOT settle on its own, so the only way for the effect to finish is to await it.

{
  const settlesOnlyAfterItsBind = async (
    name: string,
    start: (sim: SimHandler, held: (k: StepKey) => EffectContext, s: KeyScope) => Promise<unknown>,
  ) => {
    const sim = new SimHandler({
      turns: { build: { status: "done", at: 0 } },
      asks: { q: 3 },
      checkpoints: { gate: { status: "resolved", value: true, by: "sim" } },
    });
    const s = new KeyScope();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const st = { entered: false, settled: false };
    const held = (k: StepKey): EffectContext => ({
      ...ctxFor(k),
      bind: async () => { st.entered = true; await gate; },
    });
    const running = start(sim, held, s).then(() => { st.settled = true; });
    // Several macrotask turns, not one microtask drain: an effect that dropped the await would have
    // advanced its clock and returned many times over by now.
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    ok(`${name} reaches its bind and does NOT settle while that bind is in flight`,
      st.entered && !st.settled, { ...st });
    release();
    await running;
    ok(`${name} settles once its bind has completed`, st.settled, { ...st });
  };

  await settlesOnlyAfterItsBind("spawn",
    (sim, held, s) => sim.spawn({ persona: "builder" }, held(s.nextEffect("spawn", ""))));
  await settlesOnlyAfterItsBind("a turn",
    (sim, held, s) => sim.turn({ agent: { agent: "a", persona: "p" } }, held(s.nextEffect("turn", "build"))));
  await settlesOnlyAfterItsBind("an ask",
    (sim, held, s) => sim.ask({ agent: { agent: "a", persona: "p" }, schema: {} }, held(s.nextEffect("ask", "q"))));
  await settlesOnlyAfterItsBind("a checkpoint",
    (sim, held, s) => sim.checkpoint({ prompt: "ok?" }, held(s.nextEffect("checkpoint", "gate"))));
}

// ---- 9) unused script entries are reported --------------------------------------------------------------

{
  const sim = new SimHandler({
    turns: { build: { status: "done", at: 0 }, "verify-it": { status: "done", at: 0 } },
  });
  const s = new KeyScope();
  await sim.turn({ agent: { agent: "a", persona: "p" } }, ctxFor(s.nextEffect("turn", "build")));
  const unused = sim.unusedScript();
  // Usually a renamed step. A script that silently stops matching is a test that silently stops
  // testing, which is the failure this reports.
  ok("script entries the run never reached are named", unused.length === 1 && unused[0] === "turns.verify-it", unused);
}

console.log(`sim.smoke: ${pass} checks passed`);
