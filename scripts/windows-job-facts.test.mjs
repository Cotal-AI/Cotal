import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const read = ext => readFileSync(new URL(`./windows-job-facts.${ext}`, import.meta.url), 'utf8');
const js = read('mjs'), ps = read('ps1'), cs = read('cs');
test('preserved original creation result alone cannot classify exact containment', () => {
  // Original run 43537292584 kill/breakaway.json. inAnyJob is not exact membership.
  const original = { created: true, lastError: 0, flags: 'CREATE_BREAKAWAY_FROM_JOB', identity: { pid: 2060, token: '134390913875496637', inAnyJob: true } };
  assert.equal(original.created, true);
  assert.equal(original.identity.inJob, undefined);
  assert.doesNotMatch(js, /if \(breakaway\.created\) throw/);
  const body = js.match(/const requireContained = facts => \{ (.*?) \};/);
  assert.ok(body);
  const corrected = new Function('facts', body[1]);
  const fixture = inJob => [{ pid: 2060, token: '134390913875496637', beforeToken: '134390913875496637', currentToken: '134390913875496637', queryError: null, inJob }];
  assert.doesNotThrow(() => corrected(fixture(true)));
  for (const result of [false, null, undefined]) assert.throws(() => corrected(fixture(result)), /unknown or outside/);
  assert.throws(() => corrected([{ ...fixture(true)[0], currentToken: 'reused' }]), /unknown or outside/);
  assert.throws(() => corrected([{ ...fixture(true)[0], queryError: 'query failed' }]), /unknown or outside/);
  assert.ok(js.includes("await reconcile('before-request-census'"));
  assert.ok(js.includes('requireContained(membership)'));
});
test('request barrier and full census precede readiness, and successful creation is retained', () => {
  assert.ok(js.indexOf("await reconcile('before-request-census'") < js.indexOf("writeFileSync(join(dir, 'breakaway-request')"));
  assert.ok(cs.indexOf('"helper-ready.json"') < cs.indexOf('bool ok=CreateProcessW'));
  assert.ok(cs.includes('lifetime.ElapsedMilliseconds<120000'));
  assert.ok(js.includes('if (breakaway.created) census.push(breakaway.identity)'));
  assert.ok(js.includes('sorted(members) !== sorted(census.map(p => p.pid))'));
  assert.ok(js.indexOf('save(`${stage}-reconciled.json`') < js.indexOf('requireContained(membership)'));
  assert.ok(cs.includes('ready["census"]'));
  assert.ok(cs.includes('bool[] liveBefore=States(pinned)'));
  assert.ok(cs.includes('bool[] liveAfter=States(pinned)'));
});
test('every job-derived PID is pinned before identity and retained through intervention', () => {
  assert.ok(cs.includes('input["members"]'));
  assert.ok(cs.indexOf('handles.Add(h)') < cs.indexOf('"census birth"'));
  assert.ok(cs.includes('SELECT ProcessId, ParentProcessId, Name FROM Win32_Process WHERE ProcessId = '));
  for (const field of ['parentScope', 'imageName', 'pinnedBeforeIdentity']) assert.ok(cs.includes(`"${field}"`));
  assert.ok(cs.includes('stage+"-pinned.json",facts); throw;'));
  assert.ok(cs.includes('"census-agent-stop"'));
  assert.ok(ps.includes('System.Management.dll'));
  assert.ok(ps.includes("@('census',(Quote $dir))"));
  assert.ok(ps.indexOf("Wait-File $dir 'census-verified.json'") < ps.indexOf("(Join-Path $dir 'go')"));
  assert.ok(js.includes('Native census changed after contender pinning'));
});
test('diagnostic branch and marker admit only the existing Windows job', () => {
  const workflow = readFileSync(new URL('../.github/workflows/automatic-update-platforms.yml', import.meta.url), 'utf8');
  assert.ok(workflow.includes('branches: [test/upgrade-matrix, measure/windows-job-custody]'));
  const job = workflow.slice(workflow.indexOf('  windows-job-facts:'), workflow.indexOf('  windows-baseline:'));
  assert.ok(job.includes("contains(github.event.head_commit.message, '[windows-job-only]')"));
  assert.ok(job.includes('runs-on: windows-2022'));
  assert.ok(job.includes('node --test scripts/windows-job-facts.test.mjs'));
});
test('native setup reads allow rename-associated handles without a retry delay', () => {
  const body = cs.slice(cs.indexOf('static Dictionary<string,object> Load('), cs.indexOf('static IntPtr Pin('));
  assert.ok(body.includes('FileShare.ReadWrite|FileShare.Delete'));
  assert.ok(body.includes('reader.ReadToEnd()'));
  assert.ok(body.includes('writerHeldDuringRead=true,retry=false'));
  assert.doesNotMatch(body, /File\.ReadAllText|Thread\.Sleep|Thread\.Yield/);
  assert.ok(ps.includes('& $helper load-control $directory'));
  assert.ok(js.includes('renameSync(p + \'.tmp\', p)'));
});
test('authority admission requires one all-process kernel wait before any post-intervention gate call', () => {
  const observer = cs.slice(cs.indexOf('static void Observe('));
  const intervention = observer.indexOf('TerminateProcess(runner,197)');
  const wait = observer.indexOf('AwaitCensus(pinned,20000,out barrier)');
  const gate = observer.indexOf('bool got=Gate(h,out err)');
  assert.ok(intervention < wait && wait < gate);
  assert.ok(observer.indexOf('if(!admitted)throw') < gate);
  assert.ok(cs.includes('WaitForMultipleObjects((uint)handles.Count,handles.ToArray(),true,timeout)'));
  assert.ok(cs.includes('handles.Count>64'));
  assert.ok(cs.includes('new List<IntPtr>{self.Handle},0'));
  assert.ok(cs.includes('new List<IntPtr>{IntPtr.Zero},0'));
  assert.ok(ps.includes('& $helper wait-controls $directory'));
  assert.doesNotMatch(cs, /Thread\.Sleep/);
});
test('post-measurement cleanup accepts only ended-task HRESULT and settles owned streams before hashes', () => {
  assert.ok(ps.includes('$cause.HResult -ne -2147216629'));
  assert.ok(ps.includes('while ($null -ne $cause.InnerException)'));
  assert.ok(ps.includes('instanceAbsent=$true'));
  assert.ok(ps.includes('$censusAgent.Dispose()'));
  assert.ok(ps.indexOf('$censusAgent.Dispose()') < ps.indexOf("Save 'artifact-hashes.json'"));
  assert.ok(ps.includes('$observer.WaitForExit()'));
});
test('worker JavaScript parses', () => { const r = spawnSync(process.execPath, ['--check', fileURLToPath(new URL('./windows-job-facts.mjs', import.meta.url))]); assert.equal(r.status, 0, String(r.stderr)); });
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
  for (const s of ['GetProcessTimes', 'QueryFullProcessImageNameW', 'OpenProcessToken', 'WaitForSingleObject', 'LockFileEx(h,3', 'offset=1073741824', 'Stopwatch.GetTimestamp()', 'TerminateProcess(runner,197)', 'liveBefore=liveBefore', 'liveAfter=liveAfter', 'stream.WriteLine(J.Serialize(sample))', 'Array.Exists(liveBefore,state=>state)']) assert.ok(cs.includes(s), s);
  assert.doesNotMatch(cs, /OpenJobObject\(|CreateJobObject\(|AssignProcessToJobObject\(|Thread\.Sleep/);
  assert.ok(cs.indexOf('pinned.Add(Pin(id,false))') < cs.indexOf('TerminateProcess(runner,197)'));
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
