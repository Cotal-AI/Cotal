import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [mode, packageRoot, outputRoot, label] = process.argv.slice(2);
assert.equal(process.platform, 'win32', 'measure on native Windows only');
assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
const dist = join(resolve(packageRoot), 'dist');
const cli = join(dist, 'cotal.js');
mkdirSync(outputRoot, { recursive: true });
const home = join(outputRoot, `${label}-daemon`);
const importFrom = (file) => import(pathToFileURL(join(dist, 'daemon', file)).href);

if (mode === 'sample') {
  // Load the shipped installer exactly as the normal daemon does, then invoke its real
  // ownership-observation entry. The production worker remains unchanged.
  process.argv = [process.execPath, cli, 'daemon', 'serve', '--daemon-home', home];
  process.execArgv = ['--max-semi-space-size=1'];
  process.env.COTAL_DAEMON_NATIVE_SERVICE = '1';
  const { observeDaemonOwnedService } = await importFrom('install.js');
  const { daemonPathsFor } = await importFrom('endpoint.js');
  const paths = daemonPathsFor(home);
  const started = performance.timeOrigin + performance.now();
  const result = await observeDaemonOwnedService(paths, home);
  const ended = performance.timeOrigin + performance.now();
  const observation = { kind: 'sample', started, ended, durationMs: ended - started, result };
  if (process.env.OWNERSHIP_TIMING_LOG) appendFileSync(process.env.OWNERSHIP_TIMING_LOG, `${JSON.stringify(observation)}\n`);
  else console.log(JSON.stringify(observation));
  assert.deepEqual(result, { state: 'owned', reason: 'verified' });
} else {
  assert.equal(mode, 'run');
  const { createRequire } = await import('node:module');
  const require = createRequire(join(resolve(packageRoot), 'package.json'));
  const { mkSecretDir } = await import(pathToFileURL(require.resolve('@cotal-ai/core')).href);
  mkSecretDir(home);
  const commands = [];
  function call(verb, ...flags) {
    const args = [cli, 'daemon', verb, '--daemon-home', home, '--json', ...flags];
    const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 240_000, windowsHide: true });
    commands.push({ args, status: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error?.message });
    writeFileSync(join(outputRoot, `${label}-commands.json`), JSON.stringify(commands, null, 2));
    assert.equal(result.error, undefined, `${verb} did not complete`);
    assert.equal(result.status, 0, `${verb}: ${result.stdout}\n${result.stderr}`);
  }
  let installed = false;
  try {
    call('install');
    installed = true;
    for (let sample = 1; sample <= 5; sample++) {
      const log = join(outputRoot, `${label}-${sample}.jsonl`);
      const result = spawnSync(process.execPath, ['--import', pathToFileURL(resolve('scripts/measure-windows-ownership-hook.mjs')).href,
        resolve('scripts/measure-windows-ownership.mjs'), 'sample', packageRoot, outputRoot, label], {
        env: { ...process.env, OWNERSHIP_TIMING_LOG: log }, encoding: 'utf8', timeout: 100_000, windowsHide: true,
      });
      writeFileSync(join(outputRoot, `${label}-${sample}-output.json`), JSON.stringify({ status: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error?.message }, null, 2));
      assert.equal(result.error, undefined, 'sample completed');
      assert.equal(result.status, 0, `sample ${sample}: ${result.stderr}`);
      const events = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
      const worker = events.find(e => e.kind === 'worker-start');
      const first = events.find(e => e.kind === 'native-start' && e.threadId !== 0);
      const native = events.filter(e => e.kind === 'native-end' && e.threadId !== 0);
      const observation = events.find(e => e.kind === 'sample');
      assert.ok(worker && first && native.length >= 2 && observation, 'expected worker and native call timing hooks');
      const ps = native.find(e => /powershell\.exe$/i.test(e.file));
      assert.ok(ps && ps.phases.length >= 8, 'each PowerShell phase was measured');
      const at = Object.fromEntries(ps.phases.map(p => [p.phase, p.at]));
      const stock = spawnSync(process.execPath, [resolve('scripts/measure-windows-ownership.mjs'), 'sample', packageRoot, outputRoot, label], {
        encoding: 'utf8', timeout: 100_000, windowsHide: true,
      });
      writeFileSync(join(outputRoot, `${label}-${sample}-stock.json`), JSON.stringify({ status: stock.status, stdout: stock.stdout, stderr: stock.stderr, error: stock.error?.message }, null, 2));
      assert.equal(stock.error, undefined, 'uninstrumented observation completed');
      assert.equal(stock.status, 0, `uninstrumented sample ${sample}: ${stock.stderr}`);
      const stockObservation = JSON.parse(stock.stdout);
      const row = { label, sample, stockTotalMs: stockObservation.durationMs, totalMs: observation.durationMs, workerToFirstNativeMs: first.at - worker.at,
        whoamiMs: native.find(e => /whoami\.exe$/i.test(e.file)).durationMs,
        powershellMs: ps.durationMs, powershellStartMs: at['process-entry'] - ps.started,
        scheduledTasksImportMs: at['ScheduledTasks-end'] - at['ScheduledTasks-begin'],
        utilityImportMs: at['Microsoft.PowerShell.Utility-end'] - at['Microsoft.PowerShell.Utility-begin'],
        taskReadMs: at['task-read-end'] - at['task-read-begin'],
        powershellOtherMs: ps.durationMs - (at['process-entry'] - ps.started) - (at['ScheduledTasks-end'] - at['ScheduledTasks-begin']) - (at['Microsoft.PowerShell.Utility-end'] - at['Microsoft.PowerShell.Utility-begin']) - (at['task-read-end'] - at['task-read-begin']),
        otherMs: observation.durationMs - (first.at - worker.at) - native.reduce((sum, n) => sum + n.durationMs, 0),
        workerModules: events.filter(e => e.kind === 'module' && e.threadId !== 0 && e.at <= first.at),
      };
      appendFileSync(join(outputRoot, 'summary.jsonl'), `${JSON.stringify(row)}\n`);
      console.log(JSON.stringify({ ...row, workerModules: row.workerModules.length }));
    }
  } finally {
    if (installed) call('uninstall', '--yes');
  }
  writeFileSync(join(outputRoot, `${label}-identity.json`), JSON.stringify({ node: process.version, platform: process.platform, cli: realpathSync(cli), packageVersion: JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version }, null, 2));
}
