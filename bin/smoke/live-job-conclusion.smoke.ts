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
import { classifyLiveConclusion, inspectLiveConclusion } from "../../scripts/live-job-conclusion.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflow = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
let pass = 0, fail = 0;
function check(name: string, condition: boolean, extra?: unknown): void {
  if (condition) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
}

console.log("A. the conclusion classifier separates the three cancellation causes");
check("a job at the deadline is an explicit self-timeout",
  classifyLiveConclusion({ result: "cancelled", durationSeconds: 1516, timeoutSeconds: 1500, supersedingRunId: undefined }).kind === "self-timeout");
check("a newer run for the same PR proves intentional supersession even near the deadline",
  classifyLiveConclusion({ result: "cancelled", durationSeconds: 1516, timeoutSeconds: 1500, supersedingRunId: 42 }).kind === "superseded");
check("a short cancellation with no superseder fails loud rather than inventing a cause",
  classifyLiveConclusion({ result: "cancelled", durationSeconds: 400, timeoutSeconds: 1500, supersedingRunId: undefined }).kind === "unexplained-cancellation");
check("an ordinary success needs no cancellation diagnosis",
  classifyLiveConclusion({ result: "success", durationSeconds: 550, timeoutSeconds: 1500, supersedingRunId: undefined }).kind === "not-cancelled");

const json = (value: unknown): Response => new Response(JSON.stringify(value), { status: 200 });
const base = {
  result: "cancelled", repo: "Cotal-AI/Cotal", runId: 10, attempt: 1, workflow: "ci.yml", job: "live",
  timeoutSeconds: 1500, event: "push", prNumber: 0, headRef: "",
};
const timeoutVerdict = await inspectLiveConclusion(base, "token", async (url: string | URL | Request) => {
  check("the real classifier reads the current run attempt's jobs", String(url).includes("/runs/10/attempts/1/jobs?per_page=100"), url);
  return json({ jobs: [{ name: "live", started_at: "2026-08-29T00:00:00Z", completed_at: "2026-08-29T00:25:16Z" }] });
});
check("the API path classifies the measured 1516-second shape as self-timeout", timeoutVerdict.kind === "self-timeout", timeoutVerdict);

const supersededVerdict = await inspectLiveConclusion({ ...base, event: "pull_request", prNumber: 967, headRef: "fix/test" }, "token", async (url: string | URL | Request) => {
  const path = String(url);
  // A whole-run supersession can land before live starts. No timestamps is lawful in that case and
  // must not obscure the positive newer-run proof.
  if (path.includes("/attempts/1/jobs")) return json({ jobs: [{ name: "live", started_at: null, completed_at: null }] });
  if (path.endsWith("/actions/runs/10")) return json({ created_at: "2026-08-29T00:00:00Z" });
  if (path.includes("/actions/workflows/ci.yml/runs")) return json({ workflow_runs: [
    { id: 10, created_at: "2026-08-29T00:00:00Z", pull_requests: [{ number: 967 }] },
    { id: 11, created_at: "2026-08-29T00:06:00Z", pull_requests: [{ number: 967 }] },
  ] });
  return new Response("unexpected URL", { status: 500 });
});
check("the API path identifies the newer run for the same PR as intentional supersession",
  supersededVerdict.kind === "superseded" && supersededVerdict.supersedingRunId === 11, supersededVerdict);

console.log("\nB. the real CI aggregate reaches the classifier without adding another queued job");
function workflowJobs(src: string): Array<{ name: string; body: string }> {
  const idx = src.search(/^jobs:\s*$/m);
  const body = idx >= 0 ? src.slice(idx) : src;
  const matches = [...body.matchAll(/^  ([A-Za-z0-9_-]+):\n/gm)];
  return matches.map((m, i) => {
    const start = m.index! + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index! : body.length;
    return { name: m[1]!, body: body.slice(start, end) };
  });
}
function jobLevelAlways(body: string): boolean {
  const header = body.split(/^    steps:\n/m)[0] ?? body;
  return /^    if: always\(\)\s*$/m.test(header);
}
const jobs = workflowJobs(workflow);
const ciOk = jobs.find((j) => j.name === "ci-ok");
const alwaysJobs = jobs.filter((j) => jobLevelAlways(j.body)).map((j) => j.name);
const ciOkNeeds = ciOk?.body.match(/^\s+needs:\s*\[([^\]]+)\]/m)?.[1] ?? "";
const needNames = ciOkNeeds.split(",").map((n) => n.trim()).filter(Boolean);
const requiredNeeds = ["unit", "smoke", "live", "seat-pack", "seat-linux-arm64"];
check("ci-ok needs include unit, smoke, live, and the ARM validation leaves",
  requiredNeeds.every((n) => needNames.includes(n)), needNames);
check("the aggregate check name makes its live-outcome role visible",
  workflow.includes("name: ci-ok (live outcome classified)"));
check("the aggregate grants only read access needed for checkout and the Actions jobs API",
  /  ci-ok:\n(?:.|\n)*?    permissions:\n      actions: read\n      contents: read/.test(workflow));
check("the workflow calls the committed classifier with the measured 25-minute budget",
  workflow.includes("node scripts/live-job-conclusion.mjs")
  && workflow.includes("--timeout-seconds 1500"));
check("the classifier is inside ci-ok and runs before the aggregate gate",
  workflow.indexOf("node scripts/live-job-conclusion.mjs") < workflow.indexOf("      - name: Gate")
  && (ciOk?.body.indexOf("node scripts/live-job-conclusion.mjs") ?? -1) >= 0
  && (ciOk?.body.indexOf("node scripts/live-job-conclusion.mjs") ?? 0) < (ciOk?.body.indexOf("- name: Gate") ?? -1));
check("ci-ok is the sole job-level always aggregate",
  alwaysJobs.length === 1 && alwaysJobs[0] === "ci-ok", alwaysJobs);
const gateBody = ciOk?.body.slice(ciOk.body.indexOf("- name: Gate")) ?? "";
check("Gate fails unless all five direct needs succeed",
  requiredNeeds.every((n) => gateBody.includes(`[ "\${{ needs.${n}.result }}" = "success" ]`)),
  gateBody);

console.log(`\n${fail === 0 ? "LIVE JOB CONCLUSION SMOKE OK ✅" : "LIVE JOB CONCLUSION SMOKE FAILED ❌"}  (${pass} passed, ${fail} failed)`);
console.log(`SUITE COMPLETE: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
