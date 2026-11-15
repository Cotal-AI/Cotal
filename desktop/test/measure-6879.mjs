import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

assert.equal(process.platform, 'win32');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');

const output = join(process.env.RUNNER_TEMP, 'setup-proof', 'measure-6879');
mkdirSync(output, { recursive: true });
const root = join(process.env.LOCALAPPDATA, 'Cotal');
const node = join(root, 'node.exe');
const cli = join(root, 'runtime', 'dist', 'cotal.js');
const sys32 = (...parts) => join(process.env.SystemRoot || 'C:\\Windows', 'System32', ...parts);
const ps = sys32('WindowsPowerShell', 'v1.0', 'powershell.exe');
const whoami = sys32('whoami.exe');
const schtasks = sys32('schtasks.exe');
const proofStartedAt = new Date().toISOString();

const runNoCutoff = (file, args, customEnv = process.env, timeout = 300_000) => new Promise(resolve => {
  const startedAtMs = Date.now();
  execFile(file, args, { env: customEnv, windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
    const elapsedMs = Date.now() - startedAtMs;
    resolve({
      startedAtMs,
      elapsedMs,
      code: error ? (typeof error.code === 'number' ? error.code : null) : 0,
      signal: error?.signal ?? null,
      error: error?.message ?? null,
      stdout,
      stderr,
    });
  });
});

function sampleVitals(label) {
  const cpus = os.cpus();
  return {
    label,
    sampledAt: new Date().toISOString(),
    cpuCount: cpus.length,
    cpuModel: cpus[0]?.model ?? 'unknown',
    totalMemoryMB: Math.round(os.totalmem() / (1024 * 1024)),
    freeMemoryMB: Math.round(os.freemem() / (1024 * 1024)),
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function summarizeRuns(name, runs, boundMs = 30_000, extra = {}) {
  assert.ok(runs.length >= 5, `${name} requires at least 5 runs`);
  const coldMs = runs[0].elapsedMs;
  const warmTimes = runs.slice(1).map(r => r.elapsedMs);
  const warmMinMs = Math.min(...warmTimes);
  const warmMedianMs = median(warmTimes);
  const warmMaxMs = Math.max(...warmTimes);
  const overallMaxMs = Math.max(coldMs, warmMaxMs);
  const slowestRun = runs.reduce((best, cur) => (cur.elapsedMs > best.elapsedMs ? cur : best), runs[0]);
  return {
    step: name,
    count: runs.length,
    coldMs,
    warmMinMs,
    warmMedianMs,
    warmMaxMs,
    overallMaxMs,
    boundMs,
    marginMs: boundMs - overallMaxMs,
    marginRatio: Number((boundMs / Math.max(1, overallMaxMs)).toFixed(2)),
    within2xOf30sBound: overallMaxMs >= 15_000,
    exceeded30sBound: overallMaxMs >= boundMs,
    ...extra,
    coldSubSteps: runs[0].subSteps ?? null,
    slowestRunSubSteps: slowestRun.subSteps ?? null,
    runs,
  };
}

function buildInstrumentedReadTask(requireInstances) {
  return [
    "$t0 = [DateTime]::UtcNow",
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    "$tBeforeSched = [DateTime]::UtcNow",
    "Import-Module ScheduledTasks",
    "$tAfterSched = [DateTime]::UtcNow",
    "Import-Module Microsoft.PowerShell.Utility",
    "$tAfterUtil = [DateTime]::UtcNow",
    "$task = @(Get-ScheduledTask | Where-Object { $_.TaskPath -ceq '\\' -and $_.TaskName -ceq $env:COTAL_DAEMON_TASK })",
    "$tAfterGetTask = [DateTime]::UtcNow",
    "$comMs = 0",
    `if (${requireInstances ? '$true' : '$false'} -and $task.Count -gt 0) {`,
    "  $tCom0 = [DateTime]::UtcNow",
    "  $scheduler = New-Object -ComObject 'Schedule.Service'",
    "  $scheduler.Connect()",
    "  $registered = $scheduler.GetFolder('\\').GetTask($env:COTAL_DAEMON_TASK)",
    "  $null = [bool]$registered.Enabled; $null = [int]$registered.GetInstances(0).Count",
    "  $comMs = [int]([DateTime]::UtcNow - $tCom0).TotalMilliseconds",
    "}",
    "$tBeforeJson = [DateTime]::UtcNow",
    "$payload = @{ present = ($task.Count -gt 0); firstLineUtc = $t0.ToString('o'); importScheduledTasksMs = [int]($tAfterSched - $tBeforeSched).TotalMilliseconds; importUtilityMs = [int]($tAfterUtil - $tAfterSched).TotalMilliseconds; getScheduledTaskWmiMs = [int]($tAfterGetTask - $tAfterUtil).TotalMilliseconds; scheduleServiceComMs = $comMs }",
    "$json = ConvertTo-Json -Compress -InputObject $payload",
    "$tEnd = [DateTime]::UtcNow",
    "[Console]::Out.WriteLine($json)",
  ].join('\n');
}

function buildComOnlyReadTask() {
  return [
    "$t0 = [DateTime]::UtcNow",
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    "$tBeforeUtil = [DateTime]::UtcNow",
    "Import-Module \"$PSHOME\\Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1\"",
    "$tAfterUtil = [DateTime]::UtcNow",
    "$scheduler = New-Object -ComObject 'Schedule.Service'",
    "$scheduler.Connect()",
    "$folder = $scheduler.GetFolder('\\')",
    "$tasks = @($folder.GetTasks(1) | Where-Object { $_.Name -ceq $env:COTAL_DAEMON_TASK })",
    "$tAfterCom = [DateTime]::UtcNow",
    "$payload = @{ present = ($tasks.Count -gt 0); firstLineUtc = $t0.ToString('o'); importUtilityMs = [int]($tAfterUtil - $tBeforeUtil).TotalMilliseconds; scheduleServiceComMs = [int]($tAfterCom - $tAfterUtil).TotalMilliseconds }",
    "[Console]::Out.WriteLine((ConvertTo-Json -Compress -InputObject $payload))",
  ].join('\n');
}

async function startStressor(ioDir) {
  mkdirSync(ioDir, { recursive: true });
  const cpuCount = os.cpus().length;
  const ioCount = 2;
  const workers = [];
  for (let i = 0; i < cpuCount; i++) {
    workers.push(new Worker(`
      const { createHash } = require('node:crypto');
      const buf = Buffer.alloc(1024 * 1024, ${i + 1});
      for (;;) {
        createHash('sha256').update(buf).digest();
      }
    `, { eval: true }));
  }
  for (let i = 0; i < ioCount; i++) {
    const file = join(ioDir, `io-${i}.bin`).replaceAll('\\', '\\\\');
    workers.push(new Worker(`
      const fs = require('node:fs');
      const buf = Buffer.alloc(16 * 1024 * 1024, ${i + 17});
      for (;;) {
        const fd = fs.openSync('${file}', 'w');
        try {
          fs.writeSync(fd, buf, 0, buf.length, 0);
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        fs.readFileSync('${file}');
        try { fs.unlinkSync('${file}'); } catch {}
      }
    `, { eval: true }));
  }
  await new Promise(r => setTimeout(r, 1500));
  return {
    spec: {
      tool: 'node:worker_threads CPU + synchronous disk I/O stressor',
      cpuWorkers: cpuCount,
      cpuSettings: `${cpuCount} worker_threads continuously hashing 1 MiB buffers with SHA-256`,
      ioWorkers: ioCount,
      ioSettings: `${ioCount} worker_threads continuously writing, fsyncing (fs.fsyncSync), reading, and unlinking 16 MiB files in RUNNER_TEMP`,
    },
    async stop() {
      await Promise.all(workers.map(w => w.terminate()));
      rmSync(ioDir, { recursive: true, force: true });
    },
  };
}

async function runMeasurementPass(conditionName, sid, taskName, taskXmlPath) {
  const vitalsStart = sampleVitals(`${conditionName}-start`);
  const steps = {};

  // 1. whoami.exe /user /fo csv /nh
  const whoamiRuns = [];
  for (let i = 0; i < 5; i++) {
    const res = await runNoCutoff(whoami, ['/user', '/fo', 'csv', '/nh']);
    assert.equal(res.code, 0, res.stderr || res.stdout);
    whoamiRuns.push({ iter: i, elapsedMs: res.elapsedMs, code: res.code });
  }
  steps['whoami.exe /user /fo csv /nh'] = summarizeRuns('whoami.exe /user /fo csv /nh', whoamiRuns);

  // 2. schtasks /Create + /Run (so the task exists for READ_TASK)
  const createRuns = [];
  const runTaskRuns = [];
  const deleteRuns = [];
  for (let i = 0; i < 5; i++) {
    const cRes = await runNoCutoff(schtasks, ['/Create', '/TN', taskName, '/XML', taskXmlPath, '/F']);
    assert.equal(cRes.code, 0, cRes.stderr || cRes.stdout);
    createRuns.push({ iter: i, elapsedMs: cRes.elapsedMs, code: cRes.code });

    const rRes = await runNoCutoff(schtasks, ['/Run', '/TN', taskName]);
    assert.equal(rRes.code, 0, rRes.stderr || rRes.stdout);
    runTaskRuns.push({ iter: i, elapsedMs: rRes.elapsedMs, code: rRes.code });

    if (i < 4) {
      const d0 = Date.now();
      await runNoCutoff(schtasks, ['/Change', '/TN', taskName, '/DISABLE']);
      await runNoCutoff(schtasks, ['/End', '/TN', taskName]);
      const del = await runNoCutoff(schtasks, ['/Delete', '/TN', taskName, '/F']);
      assert.equal(del.code, 0, del.stderr || del.stdout);
      deleteRuns.push({ iter: i, elapsedMs: Date.now() - d0, code: del.code });
    }
  }
  steps['schtasks.exe /Create /TN <unit> /XML <xml>'] = summarizeRuns('schtasks.exe /Create /TN <unit> /XML <xml>', createRuns);
  steps['schtasks.exe /Run /TN <unit>'] = summarizeRuns('schtasks.exe /Run /TN <unit>', runTaskRuns);

  const freshCacheFor = stepSlug => {
    const dir = join(output, `ps-cache-${conditionName}-${stepSlug}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const cacheFile = join(dir, 'ModuleAnalysisCache');
    assert.equal(existsSync(cacheFile), false, `PSModuleAnalysisCachePath must not exist before cold run 0: ${cacheFile}`);
    return {
      psModuleAnalysisCachePath: cacheFile,
      coldCacheExistedBeforeRun0: false,
      osFileCacheNote: 'OS file cache remains warm on a hosted runner and cannot be cleared',
    };
  };

  // 3. READ_TASK (COTAL_DAEMON_TASK_INSTANCES=0, inherited PSModulePath, as in install-win32.ts registered(unit, false))
  const readTask0Cache = freshCacheFor('read-task-0');
  const readTask0Encoded = Buffer.from(buildInstrumentedReadTask(false), 'utf16le').toString('base64');
  const readTask0Runs = [];
  for (let i = 0; i < 5; i++) {
    const res = await runNoCutoff(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', readTask0Encoded], {
      ...process.env,
      PSModuleAnalysisCachePath: readTask0Cache.psModuleAnalysisCachePath,
      COTAL_DAEMON_TASK: taskName,
      COTAL_DAEMON_TASK_INSTANCES: '0',
    });
    assert.equal(res.code, 0, res.stderr || res.stdout);
    const parsed = JSON.parse(res.stdout.trim());
    const startupToFirstLineMs = Math.max(0, Date.parse(parsed.firstLineUtc) - res.startedAtMs);
    readTask0Runs.push({
      iter: i,
      elapsedMs: res.elapsedMs,
      code: res.code,
      subSteps: {
        startupToFirstLineMs,
        importScheduledTasksMs: parsed.importScheduledTasksMs,
        importUtilityMs: parsed.importUtilityMs,
        getScheduledTaskWmiMs: parsed.getScheduledTaskWmiMs,
      },
    });
  }
  steps['powershell.exe READ_TASK (instances=0, inherited PSModulePath)'] = summarizeRuns('powershell.exe READ_TASK (instances=0, inherited PSModulePath)', readTask0Runs, 30_000, readTask0Cache);

  // 4. READ_TASK (COTAL_DAEMON_TASK_INSTANCES=1, inherited PSModulePath, as in install-win32.ts registered(unit, true))
  const readTask1Cache = freshCacheFor('read-task-1');
  const readTask1Encoded = Buffer.from(buildInstrumentedReadTask(true), 'utf16le').toString('base64');
  const readTask1Runs = [];
  for (let i = 0; i < 5; i++) {
    const res = await runNoCutoff(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', readTask1Encoded], {
      ...process.env,
      PSModuleAnalysisCachePath: readTask1Cache.psModuleAnalysisCachePath,
      COTAL_DAEMON_TASK: taskName,
      COTAL_DAEMON_TASK_INSTANCES: '1',
    });
    assert.equal(res.code, 0, res.stderr || res.stdout);
    const parsed = JSON.parse(res.stdout.trim());
    const startupToFirstLineMs = Math.max(0, Date.parse(parsed.firstLineUtc) - res.startedAtMs);
    readTask1Runs.push({
      iter: i,
      elapsedMs: res.elapsedMs,
      code: res.code,
      subSteps: {
        startupToFirstLineMs,
        importScheduledTasksMs: parsed.importScheduledTasksMs,
        importUtilityMs: parsed.importUtilityMs,
        getScheduledTaskWmiMs: parsed.getScheduledTaskWmiMs,
        scheduleServiceComMs: parsed.scheduleServiceComMs,
      },
    });
  }
  steps['powershell.exe READ_TASK (instances=1, inherited PSModulePath)'] = summarizeRuns('powershell.exe READ_TASK (instances=1, inherited PSModulePath)', readTask1Runs, 30_000, readTask1Cache);

  // 5. Schedule.Service COM only with PSModulePath stripped (as in service-task.ps1)
  const comOnlyCache = freshCacheFor('com-only');
  const comOnlyEncoded = Buffer.from(buildComOnlyReadTask(), 'utf16le').toString('base64');
  const strippedEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toLowerCase() !== 'psmodulepath')),
    PSModuleAnalysisCachePath: comOnlyCache.psModuleAnalysisCachePath,
    COTAL_DAEMON_TASK: taskName,
  };
  const comOnlyRuns = [];
  for (let i = 0; i < 5; i++) {
    const res = await runNoCutoff(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', comOnlyEncoded], strippedEnv);
    assert.equal(res.code, 0, res.stderr || res.stdout);
    const parsed = JSON.parse(res.stdout.trim());
    const startupToFirstLineMs = Math.max(0, Date.parse(parsed.firstLineUtc) - res.startedAtMs);
    comOnlyRuns.push({
      iter: i,
      elapsedMs: res.elapsedMs,
      code: res.code,
      subSteps: {
        startupToFirstLineMs,
        importUtilityMs: parsed.importUtilityMs,
        scheduleServiceComMs: parsed.scheduleServiceComMs,
      },
    });
  }
  steps['powershell.exe Schedule.Service COM (PSModulePath stripped)'] = summarizeRuns('powershell.exe Schedule.Service COM (PSModulePath stripped)', comOnlyRuns, 30_000, comOnlyCache);

  // Clean up the 5th task iteration to complete the 5th delete timing
  {
    const d0 = Date.now();
    await runNoCutoff(schtasks, ['/Change', '/TN', taskName, '/DISABLE']);
    await runNoCutoff(schtasks, ['/End', '/TN', taskName]);
    const del = await runNoCutoff(schtasks, ['/Delete', '/TN', taskName, '/F']);
    assert.equal(del.code, 0, del.stderr || del.stdout);
    deleteRuns.push({ iter: 4, elapsedMs: Date.now() - d0, code: del.code });
  }
  steps['schtasks.exe /Change DISABLE + /End + /Delete'] = summarizeRuns('schtasks.exe /Change DISABLE + /End + /Delete', deleteRuns);

  // 6. Get-WinEvent Application Id=1000 (the other 30s timeout in run 43682334705 cannot-start)
  const winEventCache = freshCacheFor('win-event');
  const winEventRuns = [];
  for (let i = 0; i < 5; i++) {
    const res = await runNoCutoff(ps, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      `$ErrorActionPreference='Stop'; $start=[DateTime]::Parse('${proofStartedAt}').ToUniversalTime(); $events=@(Get-WinEvent -FilterHashtable @{LogName='Application';Id=1000;StartTime=$start} -ErrorAction SilentlyContinue); ConvertTo-Json -InputObject @($events|ForEach-Object{@{time=$_.TimeCreated.ToUniversalTime().ToString('o');id=$_.Id}}) -Compress`,
    ], { ...process.env, PSModuleAnalysisCachePath: winEventCache.psModuleAnalysisCachePath });
    assert.equal(res.code, 0, res.stderr || res.stdout);
    winEventRuns.push({ iter: i, elapsedMs: res.elapsedMs, code: res.code });
  }
  steps['powershell.exe Get-WinEvent (Application Id=1000)'] = summarizeRuns('powershell.exe Get-WinEvent (Application Id=1000)', winEventRuns, 30_000, winEventCache);

  // 7. Full end-to-end cotal daemon install --json and cotal daemon uninstall --yes --json (5 cycles)
  const daemonInstallCache = freshCacheFor('daemon-install');
  const daemonInstallRuns = [];
  const daemonUninstallRuns = [];
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('COTAL_') && !['NODE_OPTIONS', 'NODE_PATH'].includes(key)));
  Object.assign(cleanEnv, { COTAL_SKIP_CONNECTOR_SEED: '1', COTAL_TELEMETRY: 'off', DO_NOT_TRACK: '1', PSModuleAnalysisCachePath: daemonInstallCache.psModuleAnalysisCachePath });
  for (let i = 0; i < 5; i++) {
    const inst = await runNoCutoff(node, [cli, 'daemon', 'install', '--json'], cleanEnv);
    assert.equal(inst.code, 0, inst.stderr || inst.stdout);
    daemonInstallRuns.push({ iter: i, elapsedMs: inst.elapsedMs, code: inst.code });

    const readyDeadline = Date.now() + 30_000;
    while (Date.now() < readyDeadline) {
      const st = await runNoCutoff(node, [cli, 'daemon', 'status', '--json'], cleanEnv);
      if (st.code === 0) break;
      await new Promise(r => setTimeout(r, 250));
    }
    let uninst = await runNoCutoff(node, [cli, 'daemon', 'uninstall', '--yes', '--json'], cleanEnv);
    if (uninst.code !== 0) {
      await new Promise(r => setTimeout(r, 500));
      uninst = await runNoCutoff(node, [cli, 'daemon', 'uninstall', '--yes', '--json'], cleanEnv);
    }
    assert.equal(uninst.code, 0, uninst.stderr || uninst.stdout);
    daemonUninstallRuns.push({ iter: i, elapsedMs: uninst.elapsedMs, code: uninst.code });
  }
  steps['cotal daemon install --json (end-to-end)'] = summarizeRuns('cotal daemon install --json (end-to-end)', daemonInstallRuns, 30_000, daemonInstallCache);
  steps['cotal daemon uninstall --yes --json (end-to-end)'] = summarizeRuns('cotal daemon uninstall --yes --json (end-to-end)', daemonUninstallRuns, 30_000, daemonInstallCache);

  const vitalsEnd = sampleVitals(`${conditionName}-end`);
  const stepsWithin2x = Object.values(steps).filter(s => s.within2xOf30sBound).map(s => ({ step: s.step, overallMaxMs: s.overallMaxMs, marginRatio: s.marginRatio }));
  return {
    condition: conditionName,
    vitalsStart,
    vitalsEnd,
    stepsWithin2xOf30sBound: stepsWithin2x,
    steps,
  };
}

const report = {
  head: process.env.GITHUB_SHA ?? null,
  cell: 'measure-6879',
  inheritedPSModulePath: process.env.PSModulePath ?? null,
  checks: [],
  cleanupOutcome: 'ok',
};
const save = () => writeFileSync(join(output, 'result.json'), JSON.stringify(report, null, 2));
const check = (name, value) => { report.checks.push({ name, passed: Boolean(value) }); save(); assert.ok(value, name); };

try {
  const previous = join(process.env.RUNNER_TEMP, 'Cotal_0.164.7_x64-setup.exe');
  assert.ok(existsSync(previous), 'Verified 0.164.7 installer required');
  const installRes = await runNoCutoff(previous, ['/S']);
  check('Published 0.164.7 fixture installed for #6879 measurement', installRes.code === 0 && existsSync(node) && existsSync(cli));

  const sidOut = await runNoCutoff(whoami, ['/user', '/fo', 'csv', '/nh']);
  const sid = sidOut.stdout.trim().split(',').pop().replace(/^"|"$/g, '').trim();
  const probeTaskName = `cotal-probe-6879-${sid}`;
  const probeXmlPath = join(output, 'probe-task.xml');
  const xmlText = [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo><Description>Cotal 6879 probe task</Description></RegistrationInfo>',
    `  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${sid}</UserId></LogonTrigger></Triggers>`,
    `  <Principals><Principal id="Author"><UserId>${sid}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>`,
    '  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Priority>4</Priority></Settings>',
    '  <Actions Context="Author">',
    `    <Exec><Command>${node}</Command><Arguments>-e "setTimeout(()=>{},5000)"</Arguments><WorkingDirectory>${root}</WorkingDirectory></Exec>`,
    '  </Actions>',
    '</Task>',
    '',
  ].join('\r\n');
  writeFileSync(probeXmlPath, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xmlText, 'utf16le')]));

  report.unloaded = await runMeasurementPass('unloaded', sid, probeTaskName, probeXmlPath);
  save();
  check('Unloaded measurement completed 5 runs per step', Object.values(report.unloaded.steps).every(s => s.count === 5));

  const stressor = await startStressor(join(process.env.RUNNER_TEMP, 'load-io-6879'));
  report.loadSpec = stressor.spec;
  try {
    report.loaded = await runMeasurementPass('loaded', sid, probeTaskName, probeXmlPath);
    save();
  } finally {
    await stressor.stop();
  }
  check('Loaded measurement completed 5 runs per step', Object.values(report.loaded.steps).every(s => s.count === 5));
} catch (error) {
  report.failure = error.stack ?? String(error);
  process.exitCode = 1;
} finally {
  save();
  console.log(JSON.stringify({ cell: report.cell, failure: report.failure ?? null, cleanup: report.cleanupOutcome, checks: report.checks, output }, null, 2));
}
