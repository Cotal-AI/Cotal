/**
 * Issue #967: a live job that reaches its own 25-minute deadline is badged `cancelled`, exactly like
 * an intentionally superseded PR revision. The workflow now has a separate always-running
 * `live-conclusion` job that reads this run-attempt's job timing and makes the two cases distinct.
 *
 * Broker-free and network-free. The classifier cases are constructed because a pull request cannot
 * make its own GitHub runner self-timeout without withholding the very CI result under test. The
 * workflow wiring check proves the real CI entry point calls this classifier and gates on it; only a
 * post-merge Actions run can prove GitHub renders the new check as expected.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyLiveConclusion } from "../../scripts/live-job-conclusion.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflow = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
let pass = 0, fail = 0;
function check(name: string, condition: boolean, extra?: unknown): void {
  if (condition) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
}

console.log("A. the conclusion classifier separates the three cancellation causes");
check("a job at the deadline is an explicit self-timeout",
  classifyLiveConclusion({ result: "cancelled", durationSeconds: 1516, timeoutSeconds: 1500, marginSeconds: 60, supersedingRunId: undefined }).kind === "self-timeout");
check("a newer run for the same PR proves intentional supersession even near the deadline",
  classifyLiveConclusion({ result: "cancelled", durationSeconds: 1490, timeoutSeconds: 1500, marginSeconds: 60, supersedingRunId: 42 }).kind === "superseded");
check("a short cancellation with no superseder fails loud rather than inventing a cause",
  classifyLiveConclusion({ result: "cancelled", durationSeconds: 400, timeoutSeconds: 1500, marginSeconds: 60, supersedingRunId: undefined }).kind === "unexplained-cancellation");
check("an ordinary success needs no cancellation diagnosis",
  classifyLiveConclusion({ result: "success", durationSeconds: 550, timeoutSeconds: 1500, marginSeconds: 60, supersedingRunId: undefined }).kind === "not-cancelled");

console.log("\nB. the real CI workflow reaches the classifier and gates on its result");
check("the timeout-legibility job runs after live under always()",
  /  live-conclusion:\n(?:.|\n)*?    if: always\(\)\n    needs: \[live\]/.test(workflow));
check("the job grants only read access needed for checkout and the Actions jobs API",
  /  live-conclusion:\n(?:.|\n)*?    permissions:\n      actions: read\n      contents: read/.test(workflow));
check("the workflow calls the committed classifier with the 25-minute budget and 60-second evidence band",
  workflow.includes("node scripts/live-job-conclusion.mjs")
  && workflow.includes("--timeout-seconds 1500")
  && workflow.includes("--margin-seconds 60"));
check("ci-ok requires the legibility result as well as the live result",
  workflow.includes("needs: [unit, smoke, live, live-conclusion]")
  && workflow.includes('[ "${{ needs[\'live-conclusion\'].result }}" = "success" ]'));

console.log(`\n${fail === 0 ? "LIVE JOB CONCLUSION SMOKE OK ✅" : "LIVE JOB CONCLUSION SMOKE FAILED ❌"}  (${pass} passed, ${fail} failed)`);
console.log(`SUITE COMPLETE: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
