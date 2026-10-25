/** The published helper accepts only uncertainty verdicts and preserves each specific message. */
import { strict as assert } from "node:assert";
import { identityUncertaintyRefusal, type PinVerdict } from "../dist/index.js";

type Uncertainty = Parameters<typeof identityUncertaintyRefusal>[2];
type OtherKind = Exclude<PinVerdict["kind"], "torn-pin" | "torn-pairing" | "unpinned">;
const excluded: {
  [Kind in OtherKind]: Extract<PinVerdict, { kind: Kind }> extends Uncertainty ? false : true;
} = { "no-pid": true, legacy: true, match: true, gone: true, mismatch: true };
const unknownExcluded: { kind: "not-a-verdict" } extends Uncertainty ? false : true = true;
assert(Object.values(excluded).every(Boolean) && unknownExcluded);

const label = "fixture component";
const pidfile = "fixture.pid";
const cases: { verdict: Uncertainty; detail: string; next: string }[] = [
  {
    verdict: { kind: "torn-pin", raw: "garbage\ncontent" },
    detail: `its identity pin fixture.pid.identity holds unattributable content "garbage\\ncontent" - a torn or tampered write.`,
    next: "NEXT: inspect the recorded process with `ps`. If it should be stopped, stop it, then rerun this command; once the pid is dead the stale record clears automatically.",
  },
  {
    verdict: { kind: "torn-pairing", pinPid: 777 },
    detail: "its identity pin fixture.pid.identity names pid 777, not the pidfile's pid.",
    next: "NEXT: inspect both the pidfile pid and the pin pid with `ps`. Automatic cleanup follows proven death of the pidfile target. If that process should be stopped, stop it, then rerun this command; do not delete the identity pin.",
  },
  {
    verdict: { kind: "unpinned" },
    detail: "its process is live but no creation identity could be established for it, so target identity cannot be proven.",
    next: "NEXT: stop the process, then rerun this command; once the pid is dead the stale record clears automatically.",
  },
];
for (const { verdict, detail, next } of cases) {
  const refusal = identityUncertaintyRefusal(label, pidfile, verdict);
  assert(refusal instanceof Error);
  assert.equal(refusal.message, `refusing to stop ${label} at ${pidfile}: ${detail} The record is preserved.\n${next}`);
  console.log(`  ${verdict.kind}: specific refusal and next step preserved`);
}
console.log("identity uncertainty: three built-helper messages and six excluded input kinds checked");
