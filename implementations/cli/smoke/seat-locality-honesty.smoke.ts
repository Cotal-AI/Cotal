/**
 * A "NOT FOUND" SEAT IS REPORTED ONLY WHEN EVERY REACHABLE INSTANCE ANSWERED FOR ITSELF (#1638).
 *
 * netcup 2026-09-16: `cotal agent stop <seat>` answered "no managed agent on any of the 2 reachable
 * manager instances" twice for a seat a three-call union of `cotal ps` still listed as running; the
 * third stop succeeded. `cotal input --name <seat>` did the same for two seats, and the same command
 * with `--on <instance>` succeeded first time for both. The message is a definite negative that
 * names the instance count, which is the shape a reader believes, so a retry loop reads it as
 * "already gone" and stops looking for a seat that is still running.
 *
 * THE CAUSE IS THE SEARCH, NOT THE WORDING. `locateSeat` filtered the scatter to `reachable` rows
 * and concluded absence from them. But `scatterManager` marks an instance that ANSWERED WITH A
 * REFUSAL as reachable-with-an-error, and a frozen slot that never answered at all is a separate
 * row. Neither stated which seats it hosts. Counting the first as a manager that had looked and
 * found nothing, and ignoring the second, is how an incomplete search became a definite negative.
 *
 * WHAT IS GRADED. `locateSeatIn` is the whole decision as a function of the scatter rows, so the
 * matrix below needs no broker: the defect is in which rows count as evidence of absence, and that
 * is decidable from the rows. The live end-to-end face (a severed manager still hosting the seat,
 * driven through the real binary) is `smoke:cli-seat-locality`'s shape; this suite is the one that
 * can enumerate every row combination, including the ones a live fixture cannot stage reliably.
 *
 * Run: pnpm smoke:seat-locality-honesty   (no broker)
 */
import { locateSeatIn, seatMissRefusal, type SeatLocation } from "../src/commands/agents.js";
import type { ScatterInstanceReply } from "../src/lib/control.js";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ FAIL: ${name}`, extra === undefined ? "" : JSON.stringify(extra)); }
};

const A = "a".repeat(26), B = "b".repeat(26);
/** An instance that ANSWERED with its own roster. */
const answered = (instanceId: string, ...seats: string[]): ScatterInstanceReply =>
  ({ instanceId, reachable: true, data: seats.map((name) => ({ name })) });
/** An instance that answered with a REFUSAL: it is reachable, and it said nothing about its seats. */
const refused = (instanceId: string, error = "unavailable: the contract-store read failed"): ScatterInstanceReply =>
  ({ instanceId, reachable: true, error });
/** A frozen slot that never answered at all. */
const silent = (instanceId: string): ScatterInstanceReply =>
  ({ instanceId, reachable: false, liveness: "unknown" });

console.log("1. the positive control: a complete search still finds, and still reports absence");
{
  check("a seat on one of two answering managers pins to its host",
    locateSeatIn([answered(A, "seat"), answered(B)], "seat").kind === "pin"
    && (locateSeatIn([answered(A, "seat"), answered(B)], "seat") as { instanceId: string }).instanceId === A);
  const both = locateSeatIn([answered(A, "other"), answered(B, "elsewhere")], "seat");
  check("a name on NEITHER of two managers that both answered is absent (a complete search concludes)",
    both.kind === "absent" && (both as { checked: number }).checked === 2, both);
  check("a single answering manager stays unpinned (no ambiguity to resolve)",
    locateSeatIn([answered(A)], "seat").kind === "unpinned");
}

console.log("\n2. THE DEFECT: an instance that did not answer FOR ITSELF cannot license absence");
{
  // The live shape: the seat is running on the instance that went silent. Reporting "not found"
  // here is the definite negative the issue measured.
  const s = locateSeatIn([answered(A), silent(B)], "seat");
  check("a silent instance beside an answering one is UNKNOWN, never absent", s.kind === "unknown", s);
  check("...and the unknown names which instance did not answer",
    s.kind === "unknown" && s.silent.includes(B) && s.answered === 1, s);
  // The other half, and the one the old `reachable` filter actively miscounted: an instance that
  // ANSWERED WITH A REFUSAL is reachable and still said nothing about its seats.
  const r = locateSeatIn([answered(A), refused(B)], "seat");
  check("an instance that REFUSED the read is UNKNOWN too: reachable is not the same as answered", r.kind === "unknown", r);
  check("...and it is not counted as a manager that looked and found nothing",
    r.kind === "unknown" && r.answered === 1 && r.refused.some((x) => x.instanceId === B), r);
  const rr = locateSeatIn([refused(A), refused(B)], "seat");
  check("two refusals establish nothing at all: zero answered", rr.kind === "unknown" && rr.answered === 0, rr);
  // A refusal must not mask a positive: the seat is on the manager that DID answer.
  const found = locateSeatIn([answered(A, "seat"), refused(B)], "seat");
  check("a refusal elsewhere never blocks a seat that was positively located",
    found.kind === "pin" && (found as { instanceId: string }).instanceId === A, found);
  // ...and a refusing instance is never itself pinned: it never said it hosts the seat.
  const norefpin = locateSeatIn([answered(A), refused(B)], "seat");
  check("a refusing instance is never pinned as the host (it claimed no seat)",
    norefpin.kind !== "pin", norefpin);
}

console.log("\n3. what the operator is TOLD, which is where the damage landed");
{
  const absent = seatMissRefusal("seat", "cotal stop", { kind: "absent", checked: 2 });
  check("a complete search still says the seat is on none of them", absent.startsWith('no managed agent "seat" on any of the 2 reachable'), absent);
  const unknown: Extract<SeatLocation, { kind: "unknown" }> = { kind: "unknown", answered: 1, silent: [B], refused: [] };
  const msg = seatMissRefusal("seat", "cotal stop", unknown);
  // THE REGRESSION GUARD. The old sentence is a definite negative and a retry loop believes it.
  check("an incomplete search does NOT say the seat is on none of them", !/no managed agent/.test(msg), msg);
  check("...it says the location could not be established", msg.includes('could not establish where "seat" is'), msg);
  check("...it states outright that this is not a report that the seat is gone",
    msg.includes("NOT a report that it is gone"), msg);
  check("...it names the instance that did not answer, so `--on` is usable", msg.includes(B), msg);
  check("...and names the remedy", msg.includes("--on <instance>"), msg);
  const refusedMsg = seatMissRefusal("seat", "cotal input", { kind: "unknown", answered: 1, silent: [], refused: [{ instanceId: B, error: "the contract-store read failed" }] });
  check("a refusal is reported as a refusal, with the instance and its reason",
    !/no managed agent/.test(refusedMsg) && refusedMsg.includes(B) && refusedMsg.includes("the contract-store read failed"), refusedMsg);
  check("and the remedy names the verb it was called for", refusedMsg.includes("cotal input --on <instance>"), refusedMsg);
}

// DECLARED, not implied: a suite that ends early reddens no line, and `fail === 0` with a zero exit
// reads as a pass in every one of those ways out. The count is checked however the process leaves.
const EXPECTED_CELLS = 18;
process.on("exit", () => {
  const ran = pass + fail;
  if (ran !== EXPECTED_CELLS) {
    console.error(`\nSUITE INCOMPLETE — ran ${ran} of ${EXPECTED_CELLS} cells; a partial run is not a pass`);
    process.exitCode = 1;
  }
});
console.log(`\nseat-locality-honesty: ${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
