/**
 * The journal's proof: resume returns recorded results, a changed input is a diagnosable
 * divergence rather than a silent re-run, a crash mid-effect leaves something recoverable, and
 * the run clock is deterministic under replay including inside concurrency.
 *
 * The negative cases matter most. Silently re-running an effect whose inputs changed is the exact
 * bug this keying scheme exists to prevent, so "diverged" has to be a verdict the interpreter
 * cannot accidentally treat as "miss".
 */
import { Journal, RunClock } from "../src/journal.js";
import { KeyScope, digest } from "../src/keys.js";

let pass = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) throw new Error(`FAIL: ${name}${extra !== undefined ? ` - ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ok ${name}`);
};

const H = (v: unknown) => digest(v);

// ---- 1) a fresh run appends; a resumed run replays ------------------------------------------

{
  const live = new Journal({ run: "r-1" });
  const s = new KeyScope();
  const k = s.nextEffect("turn", "build");
  const h = H({ agent: "builder" });

  ok("a fresh key misses", live.lookup(k, h).verdict === "miss");
  live.begin(k, h, 1000);
  live.settle(k, { status: "ok", result: { status: "done", at: 1100 } }, 1100);

  // Resume: re-run from the top, so a NEW KeyScope allocates the same key again.
  const resumed = new Journal({ run: "r-1", entries: live.entries() });
  const s2 = new KeyScope();
  const v = resumed.lookup(s2.nextEffect("turn", "build"), h);
  ok("the same key replays after a resume", v.verdict === "replay", v.verdict);
  ok(
    "and returns the recorded result rather than performing the effect",
    v.verdict === "replay" && (v.entry.result as { status: string }).status === "done",
  );
}

// ---- 2) a changed input is a divergence, never a silent re-run ------------------------------

{
  const j = new Journal({ run: "r-2" });
  const s = new KeyScope();
  const k = s.nextEffect("ask", "estimate");
  j.begin(k, H({ agent: "planner", schema: { days: "number" } }), 1000);
  j.settle(k, { status: "ok", result: { days: 3 } }, 1100);

  const resumed = new Journal({ run: "r-2", entries: j.entries() });
  const s2 = new KeyScope();
  // The program's schema changed, which is exactly the case that makes a recorded answer wrong.
  const v = resumed.lookup(
    s2.nextEffect("ask", "estimate"),
    H({ agent: "planner", schema: { days: "number", confidence: "number" } }),
  );
  ok("a changed input hash diverges", v.verdict === "diverged", v.verdict);
  ok(
    "and the verdict carries both hashes so the error can print a diff",
    v.verdict === "diverged" && v.recordedHash !== v.programHash,
  );
  ok(
    "the divergence is NOT reported as a miss, which would silently re-ask the agent",
    v.verdict !== "miss",
  );
}

// ---- 3) a crash mid-effect leaves something recoverable --------------------------------------

{
  const j = new Journal({ run: "r-3" });
  const s = new KeyScope();
  const k = s.nextEffect("turn", "build");
  const h = H({ agent: "builder" });
  j.begin(k, h, 1000);
  j.bind(k, { goalId: "g-77" });
  // ...and the host dies here, before the turn settles.

  const resumed = new Journal({ run: "r-3", entries: j.entries() });
  const v = resumed.lookup(new KeyScope().nextEffect("turn", "build"), h);
  ok("an unsettled effect replays as pending", v.verdict === "pending", v.verdict);
  ok(
    "and points at the external resource to re-bind to, so no second goal is issued",
    v.verdict === "pending" && (v.entry.external as { goalId: string }).goalId === "g-77",
  );
}

// ---- 4) failures and cancellations replay as themselves ---------------------------------------

{
  const j = new Journal({ run: "r-4" });
  const s = new KeyScope();
  const kf = s.nextEffect("turn", "build");
  j.begin(kf, H({ agent: "b" }), 1000);
  j.settle(kf, { status: "failed", error: { code: "L4002", kind: "agent-down", message: "died" } }, 1100);
  const kc = s.nextEffect("turn", "build");
  j.begin(kc, H({ agent: "b" }), 1200);
  j.settle(kc, { status: "cancelled" }, 1250);

  const r = new Journal({ run: "r-4", entries: j.entries() });
  const s2 = new KeyScope();
  ok("a failed effect replays its throw", r.lookup(s2.nextEffect("turn", "build"), H({ agent: "b" })).verdict === "replay-failed");
  ok("a cancelled effect replays as cancelled", r.lookup(s2.nextEffect("turn", "build"), H({ agent: "b" })).verdict === "replay-cancelled");
}

// ---- 5) a retry loop: each iteration is its own entry -----------------------------------------

// This is the mechanism standing in for the plan's `rescue` keyword, so it has to survive a
// resume: attempt 0 failed, attempt 1 succeeded, and a replay must reproduce both in order.
{
  const j = new Journal({ run: "r-5" });
  const s = new KeyScope();
  const k0 = s.nextEffect("turn", "build");
  j.begin(k0, H({ agent: "b1" }), 1000);
  j.settle(k0, { status: "failed", error: { code: "L4002", kind: "agent-down", message: "died" } }, 1100);
  const k1 = s.nextEffect("turn", "build");
  j.begin(k1, H({ agent: "b2" }), 1200);
  j.settle(k1, { status: "ok", result: { status: "done", at: 1300 } }, 1300);

  const r = new Journal({ run: "r-5", entries: j.entries() });
  const s2 = new KeyScope();
  const v0 = r.lookup(s2.nextEffect("turn", "build"), H({ agent: "b1" }));
  const v1 = r.lookup(s2.nextEffect("turn", "build"), H({ agent: "b2" }));
  ok("the failed attempt replays first", v0.verdict === "replay-failed");
  ok("the respawned attempt replays second", v1.verdict === "replay");
  ok("the two attempts are distinct entries", j.entries().length === 2);
}

// ---- 6) orphans: what an edit removed ---------------------------------------------------------

{
  const j = new Journal({ run: "r-6" });
  const s = new KeyScope();
  for (const [kind, name] of [["turn", "build"], ["spawn", ""], ["sleep", ""]] as const) {
    const k = s.nextEffect(kind, name);
    j.begin(k, H({ n: name }), 1000);
    j.settle(k, { status: "ok", result: null }, 1100);
  }

  // The edited program only reaches the turn.
  const r = new Journal({ run: "r-6", entries: j.entries() });
  const s2 = new KeyScope();
  r.lookup(s2.nextEffect("turn", "build"), H({ n: "build" }));
  const orphans = r.orphans();
  ok("steps the new program never reached are orphans", orphans.length === 2, orphans.map((o) => o.kind));
  ok(
    "and their kinds are what decides the migration policy",
    orphans.some((o) => o.kind === "spawn") && orphans.some((o) => o.kind === "sleep"),
  );
}

// ---- 7) a dry replay must not mutate the run it is checking ------------------------------------

{
  const j = new Journal({ run: "r-7", readOnly: true });
  let threw = false;
  try {
    j.begin(new KeyScope().nextEffect("turn", "build"), H({}), 1000);
  } catch {
    threw = true;
  }
  ok("a read-only journal refuses to append", threw);
}

// ---- 8) the run clock -------------------------------------------------------------------------

{
  const root = new RunClock(1000);
  ok("before any effect the clock is the run start", root.now() === 1000);
  root.advance(1500);
  ok("an awaited effect advances it", root.now() === 1500);
  root.advance(1200);
  ok("a later out-of-order settle cannot rewind it", root.now() === 1500);

  // Concurrency: a branch sees only its OWN history until the join. A journal-wide max would let
  // a sibling's completion leak into a branch that never awaited it, and then live execution and
  // replay would disagree about what now() returned.
  const a = root.fork();
  const b = root.fork();
  a.advance(9000);
  ok("a sibling branch's clock does not leak", b.now() === 1500, { a: a.now(), b: b.now() });
  ok("and the parent is untouched before the join", root.now() === 1500);
  root.join([a, b]);
  ok("the join takes the maximum over all branches", root.now() === 9000);
}

console.log(`journal.smoke: ${pass} checks passed`);
