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
import { requestId } from "../src/keys.js";
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
  const empty = new SimHandler({});
  const r = await resume(PROGRAM, replayed, { runId: "r-1", handler: empty });
  // The proof was real and IMPLICIT: an empty script refuses every unscripted effect, so reaching
  // this line meant nothing re-ran. Written as `true` it was indistinguishable from decoration, so
  // it now counts what the handler actually did rather than relying on the absence of a throw.
  ok("a resumed run performs ZERO effects", empty.performed().length === 0, empty.performed());
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
  const emptyC = new SimHandler({});
  await resume(CONCURRENT, again, { runId: "r-4", handler: emptyC });
  ok("a concurrent run replays performing ZERO effects", emptyC.performed().length === 0, emptyC.performed());
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

// ---- 8) an edit to an observation-stopping limit DOES diverge -----------------------------------

/**
 * This section used to claim the opposite, and asserted it with a hardcoded `true`.
 *
 * Both halves were wrong. The claim inverted when the hash rule was corrected: a timeout STOPS
 * OBSERVATION, so a record made under 10m cannot answer what a 30m wait would have seen, and
 * editing it has to diverge rather than replay. And the assertion could not have noticed either
 * way, because it never looked at the resume it had just performed. A test that passes `true` is
 * a comment with a green tick next to it.
 */
{
  const RETIMED = PROGRAM.replace('timeout: "10m"', 'timeout: "30m"');
  const j = new Journal({ run: "r-1", entries: firstJournal.entries() });
  let diverged: unknown;
  try {
    await resume(RETIMED, j, { runId: "r-1", handler: new SimHandler({}) });
  } catch (e) {
    diverged = e;
  }
  ok("editing a timeout diverges rather than replaying", diverged instanceof RunDivergence, String(diverged).slice(0, 70));
  ok(
    "and it names the checkpoint whose observation window moved",
    (diverged as RunDivergence)?.stepKey?.includes("checkpoint"),
    (diverged as RunDivergence)?.stepKey,
  );
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

// ---- 13) an edited sleep duration diverges rather than keeping the old path -------------------

/**
 * This suite was 29 checks green while this was broken, which is the reason the section exists.
 *
 * §5.12 puts `sleep.duration` on the HASHED side: it determines the recorded fact, because a
 * resumed run reads the elapsed time back through the run clock and branches on it. The
 * interpreter hashed `null`, so editing 1h to 1m left the recorded hash matching and the resumed
 * run silently kept the path the OLD duration had chosen. No divergence, no error, wrong branch.
 *
 * Nothing here tested it because every existing resume test replays a program it did not edit.
 * A durability suite that never edits the source cannot see a hashing bug at all.
 */
{
  const timed = (d: string) => `
const t0 = now();
await sleep("${d}", { name: "pause" });
if (now() - t0 >= 1800000) { await sleep("1s", { name: "long-path" }); }
else { await sleep("1s", { name: "short-path" }); }
`;
  const live = await run(timed("1h"), { runId: "r-13", handler: new SimHandler({ clock: { start: 0 } }) });
  ok("a long sleep takes the long path", keysOf(live.journal).some((k) => k.includes("long-path")), keysOf(live.journal));

  let diverged: unknown;
  try {
    await resume(timed("1m"), live.journal, { runId: "r-13", handler: new SimHandler({ clock: { start: 0 } }) });
  } catch (e) {
    diverged = e;
  }
  ok("editing the duration diverges instead of replaying", diverged instanceof RunDivergence, String(diverged).slice(0, 60));
  // Pinned on the step, not merely on the class: divergence must be reported for the SLEEP whose
  // input changed, not for whatever the run happened to reach first.
  ok("and it names the sleep as the changed step", (diverged as RunDivergence)?.stepKey?.includes("sleep:pause"), (diverged as RunDivergence)?.stepKey);
}

// ---- 14) the raw outcome is journalled and today's policy decides the disposition --------------

/**
 * The reapply half of the hash rule, which was prose for a day and is now executable.
 *
 * A handler reports WHAT HAPPENED and never whether it throws. The journal holds that raw fact,
 * and `onExpiry` is applied from current source after the journal is consulted, on the live path
 * and the replay path alike. Written the other way round the rule cannot work: a handler that
 * throws L4007 makes the journal record `failed`, and a replay under an edited `proceed` then has
 * nothing but an error to reinterpret.
 *
 * So the test is a MIGRATION, not a replay: edit only the disposition, change nothing about the
 * recorded fact, and require the resumed run to take the other path.
 */
{
  const gate = (onExpiry: string) => `
const c = await checkpoint("gate", "ok?", { timeout: "1m", onExpiry: "${onExpiry}" });
if (c.status === "expired") { await sleep("1s", { name: "continued" }); }
`;
  const script = { checkpoints: { gate: { status: "expired", by: "sim" } }, clock: { start: 0 } };

  const live = await run(gate("proceed"), { runId: "r-14", handler: new SimHandler(script) });
  ok("under proceed the program continues", keysOf(live.journal).some((k) => k.includes("continued")));

  const recorded = live.journal.entries().find((e) => e.kind === "checkpoint")?.result;
  // Pinned on the RAW shape, not on the program-facing one: if the handler's disposition ever gets
  // baked in here, every reapply below becomes unreachable and this is the assertion that says so.
  ok(
    "the journal holds the RAW outcome, not the program's view",
    JSON.stringify(recorded).includes('"outcome":"expired"'),
    recorded,
  );

  let threw: unknown;
  try {
    await resume(gate("fail"), live.journal, { runId: "r-14", handler: new SimHandler(script) });
  } catch (e) {
    threw = e;
  }
  ok("editing onExpiry to fail makes the resume throw", (threw as { code?: string })?.code === "L4007", String(threw).slice(0, 60));
}

// ---- 15) escalation: one entry, two identities -------------------------------------------------

/**
 * The program made ONE call, so there is one journal entry: the interpreter owns key allocation
 * and a second mint must not become a second occurrence. But two mints need two IDENTITIES, and
 * both have to be derivable BEFORE their mint, or a crash between minting and recording leaves
 * live work that nothing in the journal names.
 *
 * The failure this replaces had no third answer: reusing one id makes the second mint resolve as
 * cached against the first attempt, and inventing one at mint time breaks the rule that an
 * identity is journalled before dispatch.
 */
{
  const ESCALATE = `
const c = await checkpoint("gate", "Approve?", { timeout: "1m", onExpiry: "escalate", to: "david" });
log(c.status);
`;
  const logs: unknown[] = [];
  // Capture the id the HANDLER was actually given at each mint. Asserting on the recorded chain
  // alone is not enough: the chain is written from the derivation, so both mints could receive the
  // SAME identity and the record would still show two different strings. What matters is what
  // arrived at the far side, which is the thing a resumed run has to reproduce.
  const seen: string[] = [];
  const sim = new SimHandler({
      // First mint expires, the escalated one is answered.
      checkpoints: { gate: [{ status: "expired", by: "sim" }, { status: "resolved", value: true, by: "david" }] },
      clock: { start: 0 },
  });
  const inner = sim.checkpoint.bind(sim);
  (sim as unknown as { checkpoint: unknown }).checkpoint = async (req: never, ctx: { requestId: string }) => {
    seen.push(ctx.requestId);
    return inner(req, ctx as never);
  };
  const r = await run(ESCALATE, { runId: "r-15", onLog: (l) => logs.push(l.values[0]), handler: sim });

  ok("the two mints were issued under DIFFERENT identities", seen.length === 2 && seen[0] !== seen[1], seen);

  const cps = r.journal.entries().filter((e) => e.kind === "checkpoint");
  ok("escalation stays inside ONE journal entry", cps.length === 1, cps.length);
  ok("and that entry is occurrence 0, not a second occurrence", cps[0]?.occurrence === 0);

  const attempts = (cps[0]?.result as { attempts?: { attempt: number; requestId: string }[] })?.attempts ?? [];
  ok("the entry records both attempts", attempts.length === 2, attempts);
  ok(
    "each attempt has its OWN identity, derivable before its mint",
    attempts[0]?.requestId !== undefined && attempts[1]?.requestId !== undefined
      && attempts[0]?.requestId !== attempts[1]?.requestId,
    attempts.map((a) => a.requestId),
  );
  ok("the program sees the escalated answer", logs[0] === "resolved", logs);

  // THE LINE I FLAGGED AS WEAKEST, now asserted rather than believed. Attempt 1's identity is
  // derived from the checkpoint's input projection; if that projection ever drifts from the value
  // the entry is actually keyed by, the id stops being a function of its step and recovery would
  // reissue under something the far side never saw. Nothing else in the suite would notice.
  const entryHash = cps[0]?.inputHash;
  const derivedFromEntry = requestId("r-15", { scope: [], kind: "checkpoint", name: "gate", occurrence: 0 }, entryHash ?? "", 1);
  ok(
    "attempt 1's id is derived from the entry's OWN inputHash",
    derivedFromEntry === attempts[1]?.requestId,
    { derivedFromEntry, recorded: attempts[1]?.requestId, entryHash },
  );
}

// ---- 16) the three recovery rules a reviewer found unguarded ------------------------------------

{
  // (a) A COMPLETED ESCALATION TERMINATES AS EXPIRED, not as a throw. One hop, and a second expiry
  // settles exactly as `proceed` would. Treating escalate as a throwing disposition made a
  // finished chain raise L4007, which is the opposite of what the stop rule says.
  const ESC = `
const c = await checkpoint("gate", "Approve?", { timeout: "1m", onExpiry: "escalate", to: "david" });
log(c.status);
`;
  const logs: unknown[] = [];
  let threw: unknown;
  try {
    await run(ESC, {
      runId: "r-16a",
      onLog: (l) => logs.push(l.values[0]),
      handler: new SimHandler({
        checkpoints: { gate: [{ status: "expired", by: "s" }, { status: "expired", by: "s" }] },
        clock: { start: 0 },
      }),
    });
  } catch (e) {
    threw = e;
  }
  ok("a twice-expired escalation does not throw", threw === undefined, String(threw).slice(0, 60));
  ok("it settles as expired and the program decides", logs[0] === "expired", logs);
}

{
  // (b) RECOVERY SUBMITS UNDER THE RECORDED IDENTITY. Re-deriving agrees whenever nothing moved,
  // which is why it read as correct; the whole point of writing the id down is the case where it
  // does not. Plant a different id on the pending row and require the handler to see THAT.
  const P = `await turn(await spawn("a", { name: "a" }), { name: "go" });\n`;
  const live = await run(P, { runId: "r-16b", handler: new SimHandler({ turns: { go: { status: "done", at: 0 } } }) });
  const entries = live.journal.entries().map((e) =>
    e.kind === "turn" ? { ...e, state: "pending" as const, status: undefined, requestId: "PLANTED-ID" } : e,
  );

  const seen: string[] = [];
  const sim = new SimHandler({ turns: { go: { status: "done", at: 0 } } });
  const innerTurn = sim.turn.bind(sim);
  (sim as unknown as { turn: unknown }).turn = async (req: never, ctx: { requestId: string }) => {
    seen.push(ctx.requestId);
    return innerTurn(req, ctx as never);
  };
  await run(P, { runId: "r-16b", handler: sim, journal: new Journal({ run: "r-16b", entries }) });
  ok("a pending effect is reissued under the RECORDED id", seen.includes("PLANTED-ID"), seen);
}

{
  // (c) THE PENDING ROW NAMES THE OPEN ATTEMPT BEFORE THE HOP IS ISSUED. Without this a crash
  // after the second mint leaves the far side holding work under an identity the journal never
  // recorded, and recovery reissues the first attempt and collects its cached expiry.
  const ESC = `await checkpoint("gate", "?", { timeout: "1m", onExpiry: "escalate", to: "d" });\n`;
  // Read the JOURNAL ROW during the second mint. An earlier version of this compared the id passed
  // to the handler against the id in the recorded chain, and both come from the same derivation:
  // deleting the journal write left every check green. The property is about the ROW, so the test
  // has to look at the row, while the hop is in flight and before anything settles.
  const journal = new Journal({ run: "r-16c" });
  let rowIdAtSecondMint: string | undefined;
  const sim = new SimHandler({
    checkpoints: { gate: [{ status: "expired", by: "s" }, { status: "resolved", value: 1, by: "d" }] },
    clock: { start: 0 },
  });
  const innerCp = sim.checkpoint.bind(sim);
  let call = 0;
  const r = await run(ESC, {
    runId: "r-16c",
    journal,
    handler: new Proxy(sim, {
      get(t, prop, recv) {
        if (prop !== "checkpoint") return Reflect.get(t, prop, recv);
        return async (req: never, ctx: { requestId: string; key: unknown }) => {
          call += 1;
          if (call === 2) {
            rowIdAtSecondMint = journal.entries().find((e) => e.kind === "checkpoint")?.requestId;
          }
          return innerCp(req, ctx as never);
        };
      },
    }) as never,
  });
  const chain = (r.journal.entries()[0]?.result as { attempts?: { requestId: string }[] })?.attempts ?? [];
  ok(
    "the pending ROW names attempt 1 while the hop is in flight",
    rowIdAtSecondMint !== undefined && rowIdAtSecondMint === chain[1]?.requestId,
    { rowIdAtSecondMint, recorded: chain[1]?.requestId },
  );
}

console.log(`interpret.smoke: ${pass} checks passed`);
