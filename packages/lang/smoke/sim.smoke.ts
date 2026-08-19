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
import { KeyScope, stepKeyString, type StepKey } from "../src/keys.js";

let pass = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) throw new Error(`FAIL: ${name}${extra !== undefined ? ` - ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ok ${name}`);
};

const bound: Record<string, unknown>[] = [];
// ⚠️ THIS DOUBLE WAS MISSING TWO FIELDS THE INTERPRETER ALWAYS SUPPLIES. `requestId` and
// `attempt` are not optional on `EffectContext`, so a handler reading either one saw `undefined`
// under these tests and a real value in production — the double and the thing it stands in for
// disagreeing, with nothing to say so while the suite ran under tsx.
const ctxFor = (key: StepKey, attempt = 0): EffectContext => ({
  key,
  signal: { cancelled: false, onCancel: () => {} },
  requestId: `${stepKeyString(key)}@${attempt}`,
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
  const scriptWith = (status: string) => ({
    checkpoints: { gate: { status, value: true, at: 999_999 } },
    clock: { start: 500 },
  });

  const resolved = await simFrom(scriptWith("resolved"))
    .checkpoint({ prompt: "ok?" }, ctxFor(new KeyScope().nextEffect("checkpoint", "gate")));
  ok("a scripted `at` is discarded on the RESOLVED path, which stamps virtual time", resolved.at === 60_500, resolved);

  const expired = await simFrom(scriptWith("expired"))
    .checkpoint({ prompt: "ok?" }, ctxFor(new KeyScope().nextEffect("checkpoint", "gate")));
  ok("a scripted `at` is discarded on the EXPIRED path too, which is the other return", expired.at === 60_500, expired);
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
