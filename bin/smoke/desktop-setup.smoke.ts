import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInNewContext } from "node:vm";
import { assertDesktopSetupComplete } from "../daemon/desktop-setup.js";

const home = mkdtempSync(join(tmpdir(), "desktop-setup-"));
const executable = join(home, "installation", "node.exe");
const folder = join(home, "CotalSetup");
const file = join(folder, "service-update.json");
try {
  mkdirSync(folder);
  mkdirSync(join(home, "installation"));
  mkdirSync(join(home, "other"));
  assert.doesNotThrow(() => assertDesktopSetupComplete(executable, home, "win32"));
  for (const phase of ["preparing", "copying", "activating"]) {
    writeFileSync(file, JSON.stringify({ schema: 1, installPath: join(home, "installation"), phase }));
    assert.throws(() => assertDesktopSetupComplete(executable, home, "win32"), /Setup was interrupted/);
  }
  writeFileSync(file, JSON.stringify({ schema: 1, installPath: join(home, "installation"), phase: "ready" }));
  assert.doesNotThrow(() => assertDesktopSetupComplete(executable, home, "win32"));
  writeFileSync(file, JSON.stringify({ schema: 1, installPath: join(home, "other"), phase: "copying" }));
  assert.doesNotThrow(() => assertDesktopSetupComplete(executable, home, "win32"));
  writeFileSync(file, JSON.stringify({ schema: 1, installPath: join(home, "missing"), phase: "copying" }));
  assert.throws(() => assertDesktopSetupComplete(executable, home, "win32"), /installation folder could not be identified/);
  writeFileSync(file, JSON.stringify({ schema: 1, installPath: join(home, "installation") + "/", phase: "copying" }));
  assert.throws(() => assertDesktopSetupComplete(executable, home, "win32"), /Setup was interrupted/);
  writeFileSync(file, "broken");
  assert.throws(() => assertDesktopSetupComplete(executable, home, "win32"), /could not be read/);
  assert.doesNotThrow(() => assertDesktopSetupComplete(executable, home, "linux"));
  console.log("PASS interrupted setup blocks service start and admission, ready and unrelated installations remain available");
} finally { rmSync(home, { recursive: true, force: true }); }

const workflow = readFileSync(new URL("../../.github/workflows/windows-setup-proof.yml", import.meta.url), "utf8");
const verdict = workflow.split("\n  verdict:\n")[1].split("          script: |\n")[1].replace(/^ {12}/gm, "");
const probe = "native (0, path-probe)";
const expected = ["build", "stock-ui-control", probe, ...["running", "stopped", "absent", "fresh", "occupied"].map(name => `native (0, ${name})`)];
const completed = (name: string, attempt: number, conclusion = "success") => ({ name, run_attempt: attempt, status: "completed", conclusion });
const queued = { name: probe, run_attempt: 2, status: "queued", conclusion: null };
const reused = expected.filter(name => name !== probe).map(name => completed(name, 1));
const runningVerdict = { ...queued, name: "verdict", status: "in_progress" };
type Job = { name: string; run_attempt: number; status: string; conclusion: string | null };

function runVerdict(readJobs: () => Job[]) {
  const env = { BUILD_RESULT: "success", NATIVE_RESULT: "success", CONTROL_RESULT: "success", EXPECTED_JOBS: JSON.stringify(expected) };
  const require = createRequire(import.meta.url);
  const endpoint = Symbol();
  return runInNewContext(`(async () => {\n${verdict}\n})()`, {
    require: (name: string) => name === "node:fs" ? { existsSync: () => false } : require(name),
    process: { env },
    context: { repo: {}, runId: 1 },
    github: {
      rest: { actions: { listJobsForWorkflowRun: endpoint } },
      paginate: (method: symbol, args: { filter: string }) => {
        assert.equal(method, endpoint);
        assert.equal(args.filter, "all");
        return readJobs();
      },
    },
    setTimeout: (resolve: () => void, ms: number) => { assert.equal(ms, 10_000); resolve(); },
  }) as Promise<void>;
}

const failedFirstAttempt = completed(probe, 1, "failure");
const passedRerun = completed(probe, 2);
let reads = 0;
await runVerdict(() => {
  const rows = [...reused, queued, runningVerdict, failedFirstAttempt];
  if (++reads === 2) rows.splice(1, 0, passedRerun);
  return rows;
});
assert.equal(reads, 2);

reads = 0;
await assert.rejects(runVerdict(() => { reads++; return [...reused, completed(probe, 1), queued, runningVerdict]; }), /job did not complete: native \(0, path-probe\) \(queued\)/);
assert.equal(reads, 18);
await assert.rejects(runVerdict(() => [...reused, passedRerun, completed(probe, 2, "failure"), queued]), /job was not green: native \(0, path-probe\) \(failure\)/);
console.log("PASS setup verdict waits for completion, ignores stale duplicates, and rejects incomplete or failed reruns");
