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
import { KeyScope, type StepKey } from "../src/keys.js";

let pass = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) throw new Error(`FAIL: ${name}${extra !== undefined ? ` - ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ok ${name}`);
};

const bound: Record<string, unknown>[] = [];
const ctxFor = (key: StepKey): EffectContext => ({
  key,
  signal: { cancelled: false, onCancel: () => {} },
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
  ok("and tells the author exactly what to add", err?.message.includes('{ turns: { "verify"'), err?.message);
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
    checkpoints: { "approve-plan": { status: "resolved", value: true, by: "sim", at: 0 } },
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
  ok("and the effect bound something before settling", bound.length === 1 && "simAgent" in (bound[0] ?? {}));
  const h2 = await sim.spawn({ persona: "builder" }, ctxFor(s.nextEffect("spawn", "")));
  ok("a second spawn of the same persona is a distinct agent", h2.agent !== h.agent, h2.agent);
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
