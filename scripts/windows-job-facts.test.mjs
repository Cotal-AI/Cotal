import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const read = ext => readFileSync(new URL(`./windows-job-facts.${ext}`, import.meta.url), 'utf8');
const js = read('mjs'), ps = read('ps1'), cs = read('cs');
test('worker JavaScript parses', () => { const r = spawnSync(process.execPath, ['--check', new URL('./windows-job-facts.mjs', import.meta.url).pathname]); assert.equal(r.status, 0, String(r.stderr)); });
test('only shipped launcher and gate APIs, one launch per runner', () => {
  assert.equal((js.match(/native\.launch\(/g) || []).length, 1);
  for (const s of ['seat.lockExclusiveNb(fd)', 'api.windowsCommandLine', 'api.windowsEnvironmentBlock', 'native.jobProcesses()', 'native.inJob(p.pid)', "'0.164.6'"]) assert.ok(js.includes(s), s);
  assert.doesNotMatch(js, /req\.resolve|createRequire|packages\/workspace/);
  assert.ok(js.indexOf('seat.lockExclusiveNb(fd)') < js.indexOf('native.launch('));
  assert.ok(js.indexOf("save('quiesced.json'") < js.indexOf('closeSync(fd)'));
});
test('task action is current SID least privilege, no triggers, no restart', () => {
  for (const s of ['GetNamedPipeClientProcessId', 'Principal.RunLevel = 0', 'Principal.LogonType = 3', 'Settings.RestartCount = 0', 'Triggers.Count -ne 0', "ExecutionTimeLimit = 'PT0S'", 'SetAccessRuleProtection($true,$false)', 'RegisterTaskDefinition($name,$definition,2,']) assert.ok(ps.includes(s), s);
  assert.doesNotMatch(ps, /Stop-Process|taskkill|\.Stop\(/);
  assert.ok(ps.indexOf("Wait-File $dir 'contender-ready.json'") < ps.indexOf("(Join-Path $dir 'go')"));
});
test('native observer uses pinned identities, immediate bounded samples, no job retention', () => {
  for (const s of ['GetProcessTimes', 'QueryFullProcessImageNameW', 'OpenProcessToken', 'WaitForSingleObject', 'LockFileEx(h,3', 'offset=1073741824', 'Stopwatch.GetTimestamp()', 'TerminateProcess(runner,197)', 'childBefore=cb', 'grandchildAfter=ga', 'stream.WriteLine(J.Serialize(sample))', 'if(cb||gb||ca||ga) { failed=true']) assert.ok(cs.includes(s), s);
  assert.doesNotMatch(cs, /OpenJobObject\(|CreateJobObject\(|AssignProcessToJobObject\(|Thread\.Sleep/);
  assert.ok(cs.indexOf('child=Pin(') < cs.indexOf('TerminateProcess(runner,197)'));
  assert.ok(cs.indexOf('new StreamWriter(Path.Combine(dir,"samples.ndjson")') < cs.indexOf('TerminateProcess(runner,197)'));
});
test('direct context failure is red but does not skip main phases', () => {
  const caught = ps.indexOf("} catch { $report.contextControl=@{ error=");
  const phases = ps.indexOf("foreach ($mode in @('kill','normal'))");
  assert.ok(caught > 0 && caught < phases);
  assert.ok(ps.includes('$report.mainPass = @($report.cases'));
  assert.ok(ps.includes("$report.pass = $report.mainPass -and -not $report.contextControl.ContainsKey('error')"));
  assert.ok(ps.includes('flagsDisagree='));
});
test('scheduler context and breakaway native errors are explicit', () => {
  for (const s of ['IsProcessInJob(runner,IntPtr.Zero', 'QueryInformationJobObject(IntPtr.Zero,9', 'QueryInformationJobObject(IntPtr.Zero,4', 'perJobUserTime100ns', '0x01000000', 'error!=5', 'if(!yes && error!=33) throw']) assert.ok(cs.includes(s), s);
  assert.doesNotMatch(cs, /!File.Exists\(Path.Combine\(dir,"released.json"\)\)/);
});
