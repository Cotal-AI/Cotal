import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const labels = ["error-policy", "import-module", "output-encoding", "enumerate-all", "absence-branch", "actions", "principal", "principal-id", "principal-translate", "instance-init", "instance-branch", "com-create", "com-connect", "com-get-task", "com-get-instances", "instance-end", "serialize"];

/** Add fixed timing markers around the shipped statements without copying their implementation. */
export function taskStageScript(source) {
  const match = /const READ_TASK = (\[[\s\S]*?\])\.join\("\\n"\);/.exec(source);
  assert.ok(match, "measure shipped READ_TASK source, never a copied implementation");
  const lines = JSON.parse(match[1].replace(/,\s*\]$/, "]"));
  assert.equal(lines.length, labels.length, "review stage names when shipped READ_TASK changes");
  for (const [index, expected] of [[1, "Import-Module ScheduledTasks"], [3, "Get-ScheduledTask |"], [8, ".Translate("], [12, "$scheduler.Connect()"], [13, ".GetTask("], [14, ".GetInstances("]]) {
    assert.ok(lines[index].includes(expected), `shipped stage ${labels[index]} still matches its label`);
  }
  const marker = (stage, edge) => `[Console]::Error.WriteLine('COTAL_STAGE ${stage} ${edge} ' + [DateTime]::UtcNow.ToString('o') + ' ' + $cotalStageClock.ElapsedMilliseconds)`;
  const script = ["$cotalStageClock=[System.Diagnostics.Stopwatch]::StartNew()", marker("powershell", "start"), ...lines.flatMap((line, index) => [...(index === 8 ? ["[Console]::Error.WriteLine('COTAL_PRINCIPAL_SID ' + [bool]($principalSid -match '^S-1-'))"] : []), marker(labels[index], "start"), line, marker(labels[index], "end")])].join("\n");
  const comparison = [marker("query-named", "start"), "$named = @(Get-ScheduledTask -TaskName $env:COTAL_DAEMON_TASK -TaskPath '\\')", marker("query-named", "end")].join("\n");
  return { script, comparison, sourceSha256: createHash("sha256").update(lines.join("\n")).digest("hex"), labels };
}

/** Retain fixed stages and UTC/elapsed values only, never raw native output. */
export function taskStageMarkers(stderr) {
  return stderr.split(/\r?\n/).flatMap(line => {
    const match = /^COTAL_STAGE ([a-z-]+) (start|end) (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z) (\d+)$/.exec(line);
    return match && [...labels, "powershell", "query-named"].includes(match[1]) ? [{ stage: match[1], edge: match[2], at: match[3], elapsedMs: Number(match[4]) }] : [];
  });
}
