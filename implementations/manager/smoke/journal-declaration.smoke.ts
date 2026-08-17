/**
 * The manager's cluster document, pinned at TODAY'S WRONG SHAPE so the journal flip cannot land
 * quietly — and pinned at the invariant the flip must NOT break.
 *
 * WHY THIS SUITE IS GREEN WHILE THE DEFECT IS UNFIXED, said first because it looks backwards.
 * The defect is that spawn/launch ship as Model B — `class: "ephemeral"` — where SPEC:1465 makes
 * the class a MUST that matches the command's contract and §13.6 makes these action commands, whose
 * submissions are journal. The obvious instrument is a cell that fails today and passes when
 * the flip lands. It was asked for, and it is the wrong instrument HERE, for a mechanical reason:
 * a permanently red suite makes `mutation-proof` REFUSE — its baseline check exits 4 on an
 * already-red suite, on the grounds that every mutation would then grade KILLED for a reason that
 * has nothing to do with the mutation. One expected-red cell would therefore disable mutation
 * grading for every other cell in this file, and take `smoke:ci` red for the duration of a block
 * that is waiting on a human merge.
 *
 * So the cells below assert TODAY'S BEHAVIOUR, and their whole content is the defect. They pass
 * now, and they DIE the moment the declaration flips — which is the same measurable event, reached
 * from the other side. A cell written to die cannot be selectively vacuous, because there is
 * nothing in it but the thing that must change. The PENDING lines print what the flip must produce
 * so the next reader does not have to reconstruct it from a plan.
 *
 * THE FOURTH CELL IS THE ONE THAT MUST SURVIVE. A flip that made every command journal-class would
 * satisfy the first three and be wrong: the action composite is a MARKER on two commands, not a
 * property of the endpoint. `status`/`ps` staying ephemeral is what makes the flip selective, and
 * that cell is here to still be green afterwards.
 *
 * Run: pnpm smoke:journal-declaration
 */
import { managerClusterDocument } from "../src/manager-service-contract.js";

let ok = 0, fail = 0;
const c = (label: string, cond: boolean, detail?: unknown): void => {
  if (cond) { ok++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ FAIL: ${label}`, detail ?? ""); }
};
/** Not a cell. Prints what the flip must produce, and is counted separately so it can never be
 *  mistaken for a passing assertion — the whole failure family this campaign kept finding. */
const pending = (what: string): void => console.log(`  ⏳ PENDING (blocked on the spec changes this depends on): ${what}`);

const doc = managerClusterDocument();
const byName = new Map(doc.commands.map((r) => [r.name, r]));
const ACTIONS = ["spawn", "launch"];
const READ_ONLY = ["status", "ps", "inspect", "models"];

console.log("\n── the document exists and carries the commands this suite reasons about ──");
// Asserted before anything reads a field off them: every cell below is an absence-or-value claim
// about specific rows, and an absent row would make several of them vacuously true.
c("the cluster document declares every command this suite names",
  [...ACTIONS, ...READ_ONLY].every((n) => byName.has(n)),
  { missing: [...ACTIONS, ...READ_ONLY].filter((n) => !byName.has(n)) });

console.log("\n── TODAY'S WRONG SHAPE — each of these dies when the flip lands ──");
c("WRONG-TODAY: `spawn` is declared class `ephemeral`, not `journal`",
  byName.get("spawn")?.class === "ephemeral", byName.get("spawn"));
c("WRONG-TODAY: `launch` is declared class `ephemeral`, not `journal`",
  byName.get("launch")?.class === "ephemeral", byName.get("launch"));
pending("spawn + launch declare `class: \"journal\"` (SPEC §13.3; the action composite's submissions are journal)");

// The marker is what makes `goalId` MUST on the envelope, so its absence is not cosmetic: it is
// why the whole rail is unreachable rather than merely mis-labelled.
c("WRONG-TODAY: NO command carries the `action` marker, so no command requires a `goalId`",
  doc.commands.every((r) => !("action" in r)),
  doc.commands.filter((r) => "action" in r).map((r) => r.name));
pending("spawn + launch carry `action: true` and `readinessDeadlineMs`, joining cluster revision 6 rather than minting a seventh");

// The admission-ceiling declaration. Named here rather than in the core suite because the obligation is on the
// ENDPOINT that accepts journal submissions, and this is that endpoint's document.
c("WRONG-TODAY: the document declares no `admissionCeiling`, which SPEC §13.7 makes a MUST for a journal endpoint",
  !("admissionCeiling" in doc) && doc.commands.every((r) => !("admissionCeiling" in r)));
pending("the endpoint declares `admissionCeiling` = { maxBytes, maxDepth, maxItems }, and the canonicalizer reads its ceilings from it rather than from a constant");

console.log("\n── THE INVARIANT — this one must still be green after the flip ──");
c("the read-only commands are ephemeral, and MUST STAY ephemeral: the action composite is a marker on two commands, never a property of the endpoint",
  READ_ONLY.every((n) => byName.get(n)?.class === "ephemeral"),
  READ_ONLY.map((n) => [n, byName.get(n)?.class]));

console.log(`\nJOURNAL DECLARATION SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${ok} passed, ${fail} failed)`);
if (fail > 0) process.exitCode = 1;
