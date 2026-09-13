/**
 * THE RECONNECT EFFECT: does a reopened bridge actually carry mesh traffic again?
 *
 * WHY THIS FILE EXISTS, and it is worth stating plainly because it documents a real false green
 * that shipped on this branch. `adapter-contract.smoke.ts` asserts the SIGNATURE of
 * `CotalAdapter.connect` and the PRESENCE of `BridgeClient.reopen`. Both are necessary. Neither is
 * sufficient, and two reviewers proved it independently: deleting the `if is_reconnect: reopen()`
 * call from the adapter, and replacing `reopen`'s entire body with `return`, BOTH left that suite
 * exiting 0 and printing `cells=23 passed=23 failed=0`. A confident tally over a guard that could
 * not fail.
 *
 * The reason is structural, not an oversight to patch with more cells of the same kind. A name and
 * a signature do not change when a body is emptied, so no amount of `inspect` can see the
 * difference. Adding assertions to that suite would have made the tally larger and the guard no
 * stronger.
 *
 * So this suite asserts the EFFECT instead. It runs a real Unix socket, drives the REAL adapter
 * through the REAL gateway sequence (connect, deliver, disconnect, drop the peer, reconnect), and
 * asks the only question that matters to an operator:
 *
 *     after the reconnect, does a message pushed by the peer still reach a turn?
 *
 * That is the defect in the issue. `close()` latches the stop event and leaves `_reader` pointing
 * at a finished thread; `get_client()` is a process-wide singleton, so the gateway's reconnect
 * watcher hands the same closed client to a fresh adapter; `start()` sees a non-None reader and
 * returns having started nothing. The platform reports CONNECTED and receives NOTHING. There is no
 * exception and no log line, which is exactly why a signature test cannot find it and why an
 * operator would experience it as a seat that simply went quiet.
 *
 * Run: pnpm smoke:hermes-reconnect-effect
 */
import { strict as nodeAssert } from "node:assert";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

let cells = 0;
const assert = new Proxy(nodeAssert, {
  get(target, prop, receiver) {
    const value = Reflect.get(target, prop, receiver);
    if (typeof value !== "function") return value;
    return (...args: unknown[]) => {
      cells += 1;
      return (value as (...a: unknown[]) => unknown).apply(target, args);
    };
  },
}) as typeof nodeAssert;

/**
 * The count is a FLOOR, not a decoration.
 *
 * A derived sentinel proves the suite ran its assertions. It does not prove the suite still
 * contains them: delete one executed assertion and the tally quietly reads one lower and the shard
 * still passes, which is liveness, not coverage. Pinning the floor here is what turns a smaller
 * green into a red. Raise it deliberately when you add a cell; a drop means an assertion vanished.
 */
const EXPECTED_CELLS = 30;

if (process.platform === "win32") {
  console.log("✓ reconnect-effect smoke skipped on Windows (the Hermes connector is Unix-only)");
  console.log("COTAL_SMOKE_SENTINEL cells=1 passed=1 failed=0");
  process.exit(0);
}

const pkgDir = fileURLToPath(new URL("..", import.meta.url));
const probe = fileURLToPath(new URL("./reconnect-effect.probe.py", import.meta.url));

const python = ["python3", "python"].find((bin) => spawnSync(bin, ["-c", ""], { stdio: "ignore" }).status === 0);
assert.ok(python, "no python3/python on PATH: the reconnect effect cannot be verified");

/**
 * Each scenario runs in its OWN interpreter, and that isolation is load-bearing rather than tidy.
 *
 * `get_client()` is a process-wide singleton and the adapter binds a live asyncio loop, so running
 * the subject and the control in one process leaves the second scenario reading the first one's
 * closed loop and cached client. The first draft of this probe did exactly that and reported the
 * control as failing, which looked like a passing refuse row while actually being contamination:
 * the control failed for the wrong reason. A refuse row that fails for the wrong reason is worse
 * than no control, because it reads as proof.
 */
function runScenario(mode: "subject" | "neutered-reopen" | "deleted-call"): Record<string, string> {
  const res = spawnSync(python!, [probe, pkgDir + "plugin", mode], { encoding: "utf8", timeout: 180_000 });
  assert.equal(res.status, 0, `the ${mode} probe did not run:\n${res.stdout}\n${res.stderr}`);
  const out = Object.fromEntries(
    res.stdout
      .split("\n")
      .filter((l) => /^[A-Z_]+ /.test(l))
      .map((line) => {
        const i = line.indexOf(" ");
        return [line.slice(0, i), line.slice(i + 1).trim()];
      }),
  );
  // ASSERT THE SHAPE BEFORE READING ANY ANSWER OFF IT. A probe that crashed after printing nothing
  // would otherwise give `undefined !== "True"`, which reads as a clean failure of the subject when
  // it is really a failure of the instrument.
  for (const key of ["PUSHED_COLD", "PUSHED_WARM", "COLD_DELIVERED", "WARM_DELIVERED"])
    assert.ok(key in out, `the ${mode} probe did not report ${key}, so its silence is not a result:\n${res.stdout}`);
  return out;
}

// ---- THE SUBJECT ------------------------------------------------------------------------------
const subject = runScenario("subject");

// The peer must actually have written the COLD frame. Without this, "not delivered" could mean
// "never sent", and the headline below would be measuring the test's own plumbing.
assert.equal(subject.PUSHED_COLD, "True", "instrument: the peer must have pushed the pre-disconnect frame");

// The cold leg proves the pipe works at all, so a failure on the warm leg is attributable to the
// reconnect rather than to a bridge that never worked in this environment.
assert.equal(subject.COLD_DELIVERED, "True", "a cold connect must deliver mesh traffic into a turn");

// THE HEADLINE. This is the assertion the whole PR turns on, and it is asserted BEFORE the warm
// instrument row on purpose.
//
// The ordering is not cosmetic and the mutation harness is what proved it. When `reopen` is broken
// the client never redials, so the peer never gets a socket and the warm PUSH fails too. With the
// instrument row checked first, a real defect reddened on "the peer must have pushed the
// post-reconnect frame", which reads like a broken harness rather than the bug. The harness graded
// that WRONG-RED, correctly: the suite went red for a reason other than the cell it names. Checking
// the effect first means the defect reddens the assertion that describes it.
assert.equal(
  subject.WARM_DELIVERED,
  "True",
  "AFTER A RECONNECT THE BRIDGE MUST STILL DELIVER: this is the silent dead-bridge defect from issue #1531",
);

// Now the warm instrument row, as a diagnostic rather than a gate. On a green run the delivery
// above already implies it; it stays so that a future failure distinguishes "never redialled" from
// "redialled and dropped the message".
assert.equal(subject.PUSHED_WARM, "True", "instrument: the reconnected peer had a socket to push on");

// ---- REFUSE CONTROL 1: reopen() present but its body emptied ----------------------------------
// The exact mutation that survived the signature suite. `reopen` still exists and is still called,
// so every name-and-signature assertion in adapter-contract stays green under it.
//
// NOTE ON WHAT "NOT DELIVERED" MEANS HERE, because the first draft of this suite asserted the
// wrong thing and the run corrected it. With a dead reader the client never dials the socket
// again, so the peer never gets a connection to write on and the warm push itself fails. The
// absence is therefore visible one step EARLIER than delivery: there is no reconnection at all.
// That is a sharper signal than a dropped message, so it is asserted directly rather than folded
// into the delivery row.
const neutered = runScenario("neutered-reopen");
assert.equal(neutered.PUSHED_COLD, "True", "instrument: the neutered-reopen peer pushed its cold frame");
assert.equal(
  neutered.COLD_DELIVERED,
  "True",
  "refuse control must fail ONLY on the reconnect: its cold leg must still deliver, or it is failing for the wrong reason",
);
assert.equal(
  neutered.PUSHED_WARM,
  "False",
  "refuse control: with reopen()'s body emptied the client never redials, so the peer gets no socket to push on",
);
assert.equal(
  neutered.WARM_DELIVERED,
  "False",
  "refuse control: with reopen()'s body emptied the reconnect must go silent, or this suite cannot detect the defect it exists for",
);

// ---- REFUSE CONTROL 2 (near neighbour): the call site deleted ---------------------------------
// One line away from the subject: `reopen` is fully implemented and correct, the adapter simply
// does not call it on the reconnect path. This is the M2 mutation two reviewers reported.
const deleted = runScenario("deleted-call");
assert.equal(deleted.PUSHED_COLD, "True", "instrument: the deleted-call peer pushed its cold frame");
assert.equal(
  deleted.COLD_DELIVERED,
  "True",
  "refuse control must fail ONLY on the reconnect: its cold leg must still deliver, or it is failing for the wrong reason",
);
assert.equal(
  deleted.PUSHED_WARM,
  "False",
  "refuse control: without the reopen() call the client never redials (adapter.py M2)",
);
assert.equal(
  deleted.WARM_DELIVERED,
  "False",
  "refuse control: without the reopen() call the reconnect must go silent (adapter.py M2)",
);

// ---- THE RACE -----------------------------------------------------------------------------
// `reopen` must not mistake a reader that is still unwinding for a live one. A closed reader that
// happens to still be alive at the instant of the check gets left installed as `_reader`, and the
// next `start()` returns having started nothing: the dead bridge, rebuilt by the very method that
// exists to undo it. Being timing dependent it would surface as an occasional silent platform
// rather than a clean failure, so the probe forces the interleaving instead of hoping to see it.
assert.equal(
  subject.RACE_READER_CLEARED,
  "True",
  "reopen must not leave a closed reader installed: a reader still unwinding when reopen is called must not be mistaken for a live one",
);
assert.equal(
  subject.RACE_LIVE_READER_KEPT,
  "True",
  "reopen must LEAVE a genuinely running reader installed, or start() would run a second reader on one socket",
);

console.log(
  "reconnect effect: a reconnected bridge delivers mesh traffic; both refuse controls (emptied reopen body, " +
    "deleted call site) go silent on the warm leg while their cold legs still deliver; the clear-before-liveness " +
    "ordering holds under a forced interleaving",
);

// The floor check runs LAST, so a suite that lost an assertion fails here even though every
// remaining assertion passed.
if (cells !== EXPECTED_CELLS) {
  console.error(
    `SUITE INCOMPLETE: expected ${EXPECTED_CELLS} assertions, ran ${cells}. ` +
      `A lower count means an assertion was deleted or skipped, which a derived tally alone would report as a smaller green.`,
  );
  console.log(`COTAL_SMOKE_SENTINEL cells=${cells} passed=${cells} failed=1`);
  process.exit(1);
}
console.log(`COTAL_SMOKE_SENTINEL cells=${cells} passed=${cells} failed=0`);
