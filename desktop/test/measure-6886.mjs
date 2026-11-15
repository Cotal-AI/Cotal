import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, freemem, totalmem } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createFixtureSpace } from '../../bin/smoke/_fixture-space.mjs';
import { installFixtureSeat } from '../../bin/smoke/_fixture-seat.mjs';

assert.equal(process.platform, 'win32');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');

const readText = path => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const output = join(process.env.RUNNER_TEMP, 'setup-proof', 'measure-6886');
mkdirSync(output, { recursive: true });
const root = join(process.env.LOCALAPPDATA, 'Cotal');
const node = join(root, 'node.exe');
const runtime = join(root, 'runtime');
const cli = join(runtime, 'dist', 'cotal.js');
const appExe = join(root, 'cotal-desktop.exe');
const ps = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const repo = fileURLToPath(new URL('../../', import.meta.url));
const observerScript = join(repo, 'desktop/test/measure-6886-observer.ps1');
const observerOutFile = join(output, 'observer-result.json');

const installer = process.env.COTAL_SETUP_CANDIDATE;
assert.ok(installer && existsSync(installer), 'Published installer path is required in COTAL_SETUP_CANDIDATE');

const baseEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('COTAL_') && !['NODE_OPTIONS', 'NODE_PATH', 'PSModulePath'].includes(key))
);
Object.assign(baseEnv, { COTAL_SKIP_CONNECTOR_SEED: '1', COTAL_TELEMETRY: 'off', DO_NOT_TRACK: '1' });

const report = {
  head: process.env.GITHUB_SHA ?? null,
  cell: 'measure-6886',
  runnerNote: 'Measured on a hosted windows-2022 runner (not a slow real machine; CPU seconds and process starts still compare directly).',
  runnerSpec: {
    cpuCount: cpus().length,
    cpuModel: cpus()[0]?.model ?? null,
    totalMemoryMB: Math.round(totalmem() / (1024 * 1024)),
    freeMemoryStartMB: Math.round(freemem() / (1024 * 1024)),
  },
  installer: {
    file: installer,
    sha256: createHash('sha256').update(readFileSync(installer)).digest('hex'),
  },
  checks: [],
};

const save = () => writeFileSync(join(output, 'result.json'), JSON.stringify(report, null, 2));
const check = (name, value) => {
  report.checks.push({ name, passed: Boolean(value) });
  save();
  assert.ok(value, name);
};

const run = (file, args, customEnv = baseEnv, timeout = 300_000) =>
  new Promise(resolve => {
    const start = Date.now();
    execFile(file, args, { env: customEnv, windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        file,
        args,
        elapsedMs: Date.now() - start,
        code: error ? (typeof error.code === 'number' ? error.code : null) : 0,
        signal: error?.signal ?? null,
        error: error?.message ?? null,
        stdout,
        stderr,
      });
    });
  });

let fixture;
let serviceInstalled = false;
try {
  assert.equal(existsSync(root), false, 'Measurement requires a clean installation root');
  const installRes = await run(installer, ['/S']);
  assert.equal(installRes.code, 0, installRes.stderr || installRes.stdout);
  const installedVersion = JSON.parse(readText(join(runtime, 'package.json'))).version;
  report.installedVersion = installedVersion;
  check('Published installer installed for #6886 measurement', existsSync(appExe) && existsSync(node) && Boolean(installedVersion));

  Object.assign(process.env, baseEnv);
  const fixtureRoot = join(process.env.RUNNER_TEMP, 'measure-6886-fixture');
  fixture = await createFixtureSpace({ root: fixtureRoot, machineHome: root, runtime, node, env: baseEnv, accountSupport: true });
  await installFixtureSeat({ root: fixtureRoot, runtime, node, env: baseEnv, cwd: fixture.participant, space: fixture.space });

  const daemonInstall = await run(node, [cli, 'daemon', 'install', '--json']);
  assert.equal(daemonInstall.code, 0, daemonInstall.stderr || daemonInstall.stdout);
  serviceInstalled = true;

  // Wait for daemon service to answer
  const readyDeadline = Date.now() + 90_000;
  let initialStatus = null;
  while (Date.now() < readyDeadline) {
    const st = await run(node, [cli, 'daemon', 'status', '--json']);
    if (st.code === 0) {
      initialStatus = JSON.parse(st.stdout).result;
      if (initialStatus?.version === installedVersion) break;
    }
    await delay(500);
  }
  assert.ok(initialStatus?.version === installedVersion, 'Installed daemon service did not answer status');

  // Start the hosted Manager on the fixture space
  report.manager = await fixture.startManager();

  // Wait for daemon status to report hostSupport === 'supported' AND the space connected with launchReady Manager
  let connectedStatus = null;
  const connectDeadline = Date.now() + 60_000;
  while (Date.now() < connectDeadline) {
    const st = await run(node, [cli, 'daemon', 'status', '--json']);
    if (st.code === 0) {
      const parsed = JSON.parse(st.stdout).result;
      const acct = parsed?.account;
      const spaceConnected = acct?.spaces?.some(s => s.space === fixture.space && s.observed === 'connected');
      const mgrReady = parsed?.managers?.some(
        m => m.space === fixture.space && m.state === 'answering' && m.connectors?.some(c => c.state === 'available')
      );
      if (acct?.hostSupport === 'supported' && acct?.mode === 'account' && spaceConnected && mgrReady) {
        connectedStatus = parsed;
        break;
      }
    }
    await delay(500);
  }
  report.daemonStatusBefore = connectedStatus;
  check(
    'Daemon service and hosted Manager connected to fixture space with hostSupport=supported',
    Boolean(
      connectedStatus &&
        connectedStatus.account?.hostSupport === 'supported' &&
        connectedStatus.account?.mode === 'account' &&
        connectedStatus.account?.spaces?.some(s => s.space === fixture.space && s.observed === 'connected') &&
        connectedStatus.managers?.some(m => m.space === fixture.space && m.state === 'answering')
    )
  );

  // Run the 2x 10-minute observer (10 min connected and idle in tray, then 10 min with app quit)
  const obsRun = await run(
    ps,
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      observerScript,
      '-AppPath',
      appExe,
      '-NodePath',
      node,
      '-WorkDir',
      root,
      '-OutFile',
      observerOutFile,
      '-CountsUrl',
      fixture.countsUrl,
      '-VisibleMinutes',
      '2',
      '-Minutes',
      '10',
    ],
    baseEnv,
    2_100_000
  );
  if (obsRun.code !== 0 || !existsSync(observerOutFile)) {
    throw new Error(`Observer script failed (code=${obsRun.code}): ${obsRun.stderr || obsRun.stdout}`);
  }
  const measurement = JSON.parse(readText(observerOutFile));
  report.measurement = measurement;
  report.idpRequestCounts = fixture.counts();

  const afterSt = await run(node, [cli, 'daemon', 'status', '--json']);
  report.daemonStatusAfter = afterSt.code === 0 ? JSON.parse(afterSt.stdout).result : { code: afterSt.code, stderr: afterSt.stderr };
  report.runnerSpec.freeMemoryEndMB = Math.round(freemem() / (1024 * 1024));

  check(
    'Visible connected window recorded (2 minutes) with job accounting, Win32_ProcessStartTrace, and CPU counter',
    measurement.connectedVisible?.visibleAtStart === true &&
      measurement.connectedVisible?.stillVisibleAtEnd === true &&
      measurement.connectedVisible?.appAliveAtEnd === true &&
      Array.isArray(measurement.connectedVisible?.minutes) &&
      measurement.connectedVisible.minutes.length === 2 &&
      measurement.connectedVisible.summary?.totalNodeStarts > 0 &&
      measurement.connectedVisible.summary?.totalJobProcessesDelta > 0
  );
  check(
    'App launched in Windows job object, connected, and hid to tray for 10 minutes',
    measurement.connectedIdleTray?.hiddenInTrayAtStart === true &&
      measurement.connectedIdleTray?.stillHiddenAtEnd === true &&
      measurement.connectedIdleTray?.appAliveAtEnd === true
  );
  check(
    'Connected idle tray window completed 10 minutes (600 s) with <= 3 CPU seconds per minute in the app job',
    Array.isArray(measurement.connectedIdleTray?.minutes) &&
      measurement.connectedIdleTray.minutes.length === 10 &&
      measurement.connectedIdleTray.summary?.totalNodeStarts > 0 &&
      measurement.connectedIdleTray.summary?.totalJobProcessesDelta > 0 &&
      measurement.connectedIdleTray.summary?.jobCpuSecondsPerMinute <= 3
  );
  check(
    'Quit window completed 10 minutes (600 s) after app job drained to 0 active processes',
    Array.isArray(measurement.appQuit?.minutes) &&
      measurement.appQuit.minutes.length === 10 &&
      measurement.appQuit.startAccounting?.activeProcesses === 0 &&
      measurement.appQuit.endAccounting?.activeProcesses === 0 &&
      measurement.appQuit.summary?.totalNodeStarts === 0 &&
      measurement.appQuit.summary?.totalJobProcessesDelta === 0
  );
  check(
    'Background daemon and hosted Manager remained running and connected while app was quit',
    report.daemonStatusAfter?.state === 'ready' &&
      report.daemonStatusAfter?.account?.hostSupport === 'supported' &&
      report.daemonStatusAfter?.managers?.some(m => m.space === fixture.space && m.state === 'answering')
  );
  save();
} finally {
  if (serviceInstalled) {
    const clean = await run(node, [cli, 'daemon', 'uninstall', '--yes', '--json'], baseEnv, 180_000);
    report.cleanupOutcome = clean.code === 0 ? 'ok' : `uninstall-code-${clean.code}`;
    save();
  }
  if (fixture) {
    await fixture.close().catch(() => {});
  }
}
