import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { taskStageMarkers, taskStageScript } from "./windows-task-stage-script.mjs";

const source = readFileSync(new URL("../../bin/daemon/install-win32.ts", import.meta.url), "utf8");
test("instrumentation preserves every shipped statement in order", () => {
  const result = taskStageScript(source);
  const original = JSON.parse(/const READ_TASK = (\[[\s\S]*?\])\.join\("\\n"\);/.exec(source)[1].replace(/,\s*\]$/, "]")).join("\n");
  assert.equal(result.script.split("\n").filter(line => !line.startsWith("[Console]::Error.WriteLine('COTAL_STAGE ") && !line.startsWith("[Console]::Error.WriteLine('COTAL_PRINCIPAL_SID ") && !line.startsWith("$cotalStageClock=")).join("\n"), original);
  assert.match(result.sourceSha256, /^[a-f0-9]{64}$/);
  for (const stage of ["import-module", "enumerate-all", "principal-translate", "com-connect", "com-get-task", "com-get-instances"]) assert.ok(result.script.includes(`COTAL_STAGE ${stage} end`));
  assert.ok(result.comparison.includes("Get-ScheduledTask -TaskName $env:COTAL_DAEMON_TASK -TaskPath '\\'"));
  assert.ok(!result.script.includes("-TaskName"), "named comparison never replaces enumeration");
});
test("markers retain only known fixed stages and timing fields", () => {
  const records = taskStageMarkers("private path/credential output\nCOTAL_STAGE enumerate-all start 2026-11-12T18:00:00.0000000Z 12\r\nCOTAL_STAGE arbitrary end 2026-11-12T18:00:00.0000000Z 13\nCOTAL_STAGE com-connect end 2026-11-12T18:00:00.0000000Z 14\n");
  assert.deepEqual(records, [{ stage: "enumerate-all", edge: "start", at: "2026-11-12T18:00:00.0000000Z", elapsedMs: 12 }, { stage: "com-connect", edge: "end", at: "2026-11-12T18:00:00.0000000Z", elapsedMs: 14 }]);
});

test("cold preflight precedes setup actions and cleanup precedes the unchanged scenario", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/desktop.yml", import.meta.url), "utf8").split("  native-build:")[1];
  assert.match(workflow, /steps:\n      - uses: actions\/checkout@v6\n      - name: Measure cold Windows task stages before setup or scenario\n        if: runner.os == 'Windows'\n        shell: cmd\n        timeout-minutes: 21\n        run: node desktop\/e2e\/windows-task-stage-preflight.mjs measure/);
  assert.ok(workflow.indexOf("windows-task-stage-preflight.mjs measure") < workflow.indexOf("pnpm/action-setup"));
  assert.ok(workflow.indexOf("windows-task-stage-preflight.mjs cleanup") < workflow.indexOf("Windows service installation and disabled-task recovery"));
  const preflight = readFileSync(new URL("./windows-task-stage-preflight.mjs", import.meta.url), "utf8");
  assert.ok(preflight.includes('["/Create", "/XML", unitPath, "/TN", unit]'));
  assert.ok(!preflight.includes('["/Run"') && !preflight.includes('["/Delete"') && !preflight.includes('["/End"'));
  assert.ok(preflight.includes('"daemon", "uninstall", "--daemon-home", owner.daemonHome, "--yes", "--json"'));
  assert.ok(!preflight.includes("env: owner.env"));
  const restart = readFileSync(new URL("./windows-restart.mjs", import.meta.url), "utf8");
  assert.ok(!restart.includes("measureTaskStages"));
});
