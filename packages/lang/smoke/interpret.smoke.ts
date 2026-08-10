/**
 * The end-to-end proof: real cotal-lang programs, executed.
 *
 * Every other suite in this package tests a component. This one runs programs, and it is the only
 * place the central durability claim can actually be tested, because that claim is about what the
 * interpreter does with the journal, not about what either part does alone.
 *
 * The strongest test here is section 2, and its trick is worth stating: a resumed run is given an
 * EMPTY simulation script. The simulator refuses every unscripted effect, so if any journalled
 * effect were re-performed the resume would die with L6001. Completing is therefore proof that
 * nothing re-ran, rather than an assertion that it did not.
 */
import { run, resume, RunDivergence } from "../src/interpret.js";
import { SimHandler } from "../src/sim.js";
import { Journal } from "../src/journal.js";
import { EffectError } from "../src/effects.js";

/** Collect what a program logged. A program has no return value: its outcome is what it did. */
const logged: unknown[][] = [];
const sink = (line: { scope: string; values: readonly unknown[] }) => {
  logged.push([...line.values]);
};

let pass = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) throw new Error(`FAIL: ${name}${extra !== undefined ? ` - ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ok ${name}`);
};

const keysOf = (j: Journal) =>
  j.entries().map((e) => `${e.scope}/${e.name === "" ? e.kind : `${e.kind}:${e.name}`}#${e.occurrence}`);

// ---- 1) a real program runs -------------------------------------------------------------------

const PROGRAM = `
const team = channel("feat-auth");
const planner = await spawn("planner", { worktree: "wt-1", join: [team] });
const builder = await spawn("builder", { worktree: "wt-1", join: [team] });

await turn(planner, { name: "draft-plan" });

const approval = await checkpoint("approve-plan", "Approve the plan?", { timeout: "10m", onExpiry: "proceed" });
if (approval.status === "expired") {
  await notify([planner], { decision: "approve-plan", outcome: "auto-proceeded" });
}

let r = await turn(builder, { name: "build" });
let rounds = 0;
while (r.status === "blocked") {
  rounds = rounds + 1;
  await turn(planner, { name: "unblock" });
  r = await turn(builder, { name: "build" });
}
`;

const SCRIPT = {
  turns: {
    "draft-plan": { status: "done", at: 0 } as const,
    build: [{ status: "blocked", at: 0 }, { status: "done", at: 0 }] as const,
    unblock: { status: "done", at: 0 } as const,
  },
  checkpoints: { "approve-plan": { status: "resolved", value: true, at: 0 } as const },
  clock: { start: 1_000_000 },
};

let firstJournal: Journal;
{
  const r = await run(PROGRAM, { runId: "r-1", handler: new SimHandler(SCRIPT) });
  firstJournal = r.journal;
  const keys = keysOf(r.journal);
  ok("the program ran to completion", keys.length > 0);
  ok(
    "and journalled the steps under their names, in the order they ran",
    JSON.stringify(keys) ===
      JSON.stringify([
        "/spawn:planner#0",
        "/spawn:builder#0",
        "/turn:draft-plan#0",
        "/checkpoint:approve-plan#0",
        "/turn:build#0",
        "/turn:unblock#0",
        "/turn:build#1",
      ]),
    keys,
  );
  ok("the retry loop gave the second build its own occurrence", keys.includes("/turn:build#1"));
  ok("a resolved checkpoint did not take the expired branch", !keys.some((k) => k.startsWith("/notify")));
  ok("every entry settled", r.journal.entries().every((e) => e.state === "settled"));
}

// ---- 2) resume performs NO effect it already has ------------------------------------------------

{
  // An EMPTY script: the simulator refuses every unscripted effect, so reaching the end proves
  // that nothing was re-performed. This is the claim the whole durability design rests on.
  const replayed = new Journal({ run: "r-1", entries: firstJournal.entries() });
  const r = await resume(PROGRAM, replayed, { runId: "r-1", handler: new SimHandler({}) });
  ok("a resumed run completes without performing a single effect", true);
  ok(
    "and the journal is unchanged: no new entries, no re-runs",
    JSON.stringify(keysOf(r.journal)) === JSON.stringify(keysOf(firstJournal)),
    keysOf(r.journal),
  );
}

// ---- 3) a failure is durable too, and a program that catches it carries on ------------------------

{
  // The agent dies on the second build. This program has no handler for that, so the run fails.
  const crashed = new SimHandler({ ...SCRIPT, faults: [{ at: "turn:build#1", kind: "agent-down" }] });
  let failed = false;
  let partial: Journal | null = null;
  try {
    await run(PROGRAM, { runId: "r-3", handler: crashed });
  } catch (e) {
    failed = e instanceof EffectError && e.kind === "agent-down";
    partial = (e as EffectError & { journal?: Journal }).journal ?? null;
  }
  ok("an injected agent death fails the run", failed);
  void partial;

  // The retry pattern from the design doc's D1: a loop plus try/catch, standing in for the
  // `rescue` keyword. Each attempt gets a fresh occurrence, so the retry re-runs by construction
  // rather than by anything unwinding the journal.
  const RETRY = `
let builder = await spawn("builder", { worktree: "wt-1" });
let built = null;
for (let attempt = 0; attempt < 3; attempt = attempt + 1) {
  try {
    built = await turn(builder, { name: "build" });
    break;
  } catch (e) {
    if (e.kind !== "agent-down") { throw e; }
    builder = await spawn("builder", { worktree: "wt-1" });
  }
}
log(built.status);
`;
  logged.length = 0;
  const r = await run(RETRY, {
    runId: "r-3b",
    onLog: sink,
    handler: new SimHandler({
      turns: { build: [{ status: "done", at: 0 }, { status: "done", at: 0 }] },
      faults: [{ at: "turn:build#0", kind: "agent-down" }],
    }),
  });
  ok("a loop plus try/catch recovers from a death, with no rescue keyword", (logged[0] ?? [])[0] === "done", logged[0]);
  const keys = keysOf(r.journal);
  ok(
    "the failed attempt and the retry are separate journal entries",
    keys.includes("/turn:build#0") && keys.includes("/turn:build#1"),
    keys,
  );
  ok(
    "the failed attempt is recorded as failed, not erased",
    r.journal.entries().some((e) => e.kind === "turn" && e.occurrence === 0 && e.status === "failed"),
  );

  // And it replays: the recorded failure is re-thrown, the catch runs again, the retry replays.
  const again = new Journal({ run: "r-3b", entries: r.journal.entries() });
  logged.length = 0;
  await resume(RETRY, again, { runId: "r-3b", handler: new SimHandler({}), onLog: sink });
  ok("a recovered run replays end to end with no effects performed", (logged[0] ?? [])[0] === "done", logged[0]);
}

// ---- 4) concurrency: two branches, one step name ----------------------------------------------------

{
  const CONCURRENT = `
const a = await spawn("reviewer", { role: "security" });
const b = await spawn("reviewer", { role: "perf" });
const out = await parallel({
  security: () => turn(a, { name: "review" }),
  perf: () => turn(b, { name: "review" }),
}, { name: "reviews" });
`;
  const r = await run(CONCURRENT, {
    runId: "r-4",
    handler: new SimHandler({ turns: { review: [{ status: "done", at: 0 }, { status: "done", at: 0 }] } }),
  });
  const keys = keysOf(r.journal);
  ok(
    "the same step name in two branches gets two distinct keys",
    keys.includes("/parallel:reviews#0/b:security/turn:review#0") &&
      keys.includes("/parallel:reviews#0/b:perf/turn:review#0"),
    keys,
  );
  ok("and neither branch collided onto the other's occurrence", new Set(keys).size === keys.length);

  // The same emptiness proof, now for a concurrent program: replay must touch no handler.
  const again = new Journal({ run: "r-4", entries: r.journal.entries() });
  await resume(CONCURRENT, again, { runId: "r-4", handler: new SimHandler({}) });
  ok("a concurrent run replays with no effects performed", true);
}

// ---- 5) fanOut keys by item, not by index -------------------------------------------------------------

{
  const FAN = `
const t = channel("t");
const reviews = await fanOut(
  ["security", "perf"],
  async (lens) => turn(await spawn("reviewer", { role: lens, join: [t] }), { name: "review" }),
  { name: "reviews", key: (lens) => lens },
);
`;
  const r = await run(FAN, {
    runId: "r-5",
    handler: new SimHandler({ turns: { review: [{ status: "done", at: 0 }, { status: "done", at: 0 }] } }),
  });
  const keys = keysOf(r.journal);
  ok(
    "each fan-out branch is namespaced by its key",
    keys.includes("/fanOut:reviews#0/b:security/turn:review#0") &&
      keys.includes("/fanOut:reviews#0/b:perf/turn:review#0"),
    keys,
  );
}

// ---- 6) fanOut refuses an unstable key -----------------------------------------------------------------

{
  const BAD = `
const out = await fanOut([{ n: 1 }, { n: 2 }], async (i) => turn(await spawn("r"), { name: "review" }), { name: "reviews" });
`;
  let threw = "";
  try {
    await run(BAD, { runId: "r-6", handler: new SimHandler({ turns: { review: { status: "done", at: 0 } } }) });
  } catch (e) {
    threw = (e as Error).message;
  }
  ok("items with no stable key are refused at run time", threw.includes("L3021"), threw.slice(0, 120));

  // The width control: the same mechanism, one variable changed. Items that DO carry a string id
  // must run, or the rule is refusing the documented default along with the broken case.
  const GOOD = `
const out = await fanOut(
  [{ id: "security" }, { id: "perf" }],
  async (i) => turn(await spawn("r", { role: i.id }), { name: "review" }),
  { name: "reviews" },
);
`;
  const good = await run(GOOD, {
    runId: "r-6b",
    handler: new SimHandler({ turns: { review: [{ status: "done", at: 0 }, { status: "done", at: 0 }] } }),
  });
  const gk = keysOf(good.journal);
  ok(
    "items carrying a string id key the branches by that id, with no key function",
    gk.includes("/fanOut:reviews#0/b:security/turn:review#0") && gk.includes("/fanOut:reviews#0/b:perf/turn:review#0"),
    gk,
  );

  // And duplicate keys must be refused: two branches sharing a namespace would overwrite each
  // other's steps, which is the same defect as having no key at all.
  const DUP = `
const out = await fanOut(
  [{ id: "same" }, { id: "same" }],
  async (i) => turn(await spawn("r"), { name: "review" }),
  { name: "reviews" },
);
`;
  let dup = "";
  try {
    await run(DUP, { runId: "r-6c", handler: new SimHandler({ turns: { review: { status: "done", at: 0 } } }) });
  } catch (e) {
    dup = (e as Error).message;
  }
  ok("duplicate branch keys are refused before any branch launches", dup.includes("L3024") && dup.includes("duplicate"), dup.slice(0, 100));
}

// ---- 7) a changed input diverges rather than replaying the wrong answer -------------------------------------

{
  // The checkpoint prompt is what a human read, so changing it invalidates the recorded approval.
  const EDITED = PROGRAM.replace("Approve the plan?", "Approve the REVISED plan?");
  const j = new Journal({ run: "r-1", entries: firstJournal.entries() });
  let div: RunDivergence | null = null;
  try {
    await resume(EDITED, j, { runId: "r-1", handler: new SimHandler({}) });
  } catch (e) {
    div = e instanceof RunDivergence ? e : null;
  }
  ok("editing what the human saw diverges the resume", div !== null);
  ok("and the error names the exact step", div?.stepKey === "/checkpoint:approve-plan#0", div?.stepKey);
  ok("and offers fork as the repair", div?.message.includes('fork(run, "/checkpoint:approve-plan#0")'));
}

// ---- 8) an edit that only steers live execution does NOT diverge ---------------------------------------------

{
  // The timeout is a control knob, not data: a completed checkpoint stays completed. If this
  // diverged, every deadline tweak would re-ask a human who already answered.
  const RETIMED = PROGRAM.replace('timeout: "10m"', 'timeout: "30m"');
  const j = new Journal({ run: "r-1", entries: firstJournal.entries() });
  await resume(RETIMED, j, { runId: "r-1", handler: new SimHandler({}) });
  ok("changing a timeout replays cleanly instead of re-asking the human", true);
}

// ---- 9) time advances only at effect boundaries ---------------------------------------------------------------

{
  const CLOCK = `
const a = await spawn("x");
const t0 = now();
const t1 = now();
await sleep("2h");
const t2 = now();
log(t0, t1, t2);
`;
  logged.length = 0;
  await run(CLOCK, { runId: "r-9", handler: new SimHandler({ clock: { start: 0 } }), onLog: sink });
  const [t0, t1, t2] = (logged[0] ?? []) as number[];
  const t = { t0: t0 as number, t1: t1 as number, t2: t2 as number };
  ok("two reads with no effect between them return the same instant", t.t0 === t.t1, t);
  ok("and a sleep moves the clock by its full duration", t.t2 - t.t1 === 2 * 3_600_000, t);
}

// ---- 10) randomness is deterministic under replay ----------------------------------------------------------------

{
  const RAND = `
const a = await spawn("x");
await turn(a, { name: "go" });
log(random());
`;
  const script = { turns: { go: { status: "done", at: 0 } as const } };
  logged.length = 0;
  const first = await run(RAND, { runId: "r-10", seed: "seed-1", handler: new SimHandler(script), onLog: sink });
  const firstDraw = (logged[0] ?? [])[0];
  logged.length = 0;
  await resume(
    RAND,
    new Journal({ run: "r-10", entries: first.journal.entries() }),
    { runId: "r-10", seed: "seed-1", handler: new SimHandler({}), onLog: sink },
  );
  const replayDraw = (logged[0] ?? [])[0];
  ok("a replayed run draws the same random value", firstDraw === replayDraw, { firstDraw, replayDraw });
  logged.length = 0;
  await run(RAND, { runId: "r-10", seed: "seed-2", handler: new SimHandler(script), onLog: sink });
  ok("a different seed draws a different value", firstDraw !== (logged[0] ?? [])[0]);
}

// ---- 11) ?? is Orc's otherwise -----------------------------------------------------------------------------------

{
  const OTHERWISE = `
const a = await spawn("x");
const reply = await wait(replied(a), { name: "await-reply", timeout: "20m" });
const chased = reply ?? await turn(a, { name: "chase" });
log(chased.status);
`;
  logged.length = 0;
  await run(OTHERWISE, {
    runId: "r-11",
    onLog: sink,
    handler: new SimHandler({
      events: { "await-reply": [null] },
      turns: { chase: { status: "done", at: 0 } },
    }),
  });
  ok("a timed-out event resolves null and ?? takes the fallback", (logged[0] ?? [])[0] === "done", logged[0]);
}

// ---- 12) values crossing an effect boundary are frozen ------------------------------------------------------------

{
  const FREEZE = `
const a = await spawn("x");
const r = await turn(a, { name: "go" });
let caught = "none";
try {
  r.status = "tampered";
} catch (e) {
  caught = "frozen";
}
log(caught, r.status);
`;
  logged.length = 0;
  await run(FREEZE, {
    runId: "r-12",
    onLog: sink,
    handler: new SimHandler({ turns: { go: { status: "done", at: 0 } } }),
  });
  const v = { caught: (logged[0] ?? [])[0] as string, status: (logged[0] ?? [])[1] as string };
  // Whether the assignment throws or is silently ignored, what must hold is that the recorded
  // result cannot be edited underneath the journal.
  ok("a journalled result cannot be mutated by the program", v.status === "done", v);
}

console.log(`interpret.smoke: ${pass} checks passed`);
