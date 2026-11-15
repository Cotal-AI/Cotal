import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { machineShapeOptions, machineShapeCommand, stagedSchedulerSucceeded } from './update-machine-shape.mjs';

test('native mask probes require explicit disposable platform and state', () => {
  const options = { state: 'daemon', 'install-umask': '0002', 'service-umask': '0002', 'pinned-node': '24.18.0' };
  assert.deepEqual(machineShapeOptions(options, { disposable: true, platform: 'linux' }), { installUmask: '0002', serviceUmask: '0002', pinnedNode: '24.18.0' });
  for (const environment of [{ disposable: false, platform: 'linux' }, { disposable: true, platform: 'win32' }, { disposable: true, platform: 'darwin' }]) assert.throws(() => machineShapeOptions(options, environment));
  assert.throws(() => machineShapeOptions({ 'pinned-node': '24' }, { disposable: true, platform: 'linux' }));
});

test('ordinary commands retain exact file and argument identity', () => {
  const argv = ['value with spaces', 'literal;$HOME'];
  const command = machineShapeCommand(process.execPath, argv);
  assert.equal(command.file, process.execPath);
  assert.equal(command.argv, argv);
});

test('real child receives 0002 without changing parent mask or shell-expanding arguments', { skip: process.platform === 'win32' ? 'POSIX umask only' : false }, () => {
  const before = process.umask();
  const code = 'console.log(JSON.stringify({mask:process.umask().toString(8),arg:process.argv[1]}))';
  const literal = 'space ; $HOME $(not-a-command)';
  const command = machineShapeCommand(process.execPath, ['-e', code, literal], '0002');
  const result = JSON.parse(execFileSync(command.file, command.argv, { encoding: 'utf8' }));
  assert.equal(result.mask, '2');
  assert.equal(result.arg, literal);
  assert.equal(process.umask(), before);
});

test('staged scheduler needs actual final status and no second manual updater', () => {
  const pair = { sourceVersion: '1.2.3', targetVersion: '1.2.1003', followOnVersion: '1.2.2003' };
  const status = { exit: 0, signal: null, timeout: false, stdout: JSON.stringify({ result: { state: 'ready', version: pair.followOnVersion } }), stderr: '' };
  const report = {
    stagedScheduler: { selectedBefore: { updateRoute: 'staged', selectedCliVersion: pair.targetVersion, packageManagerRecordVersion: pair.sourceVersion }, selected: { selectedCliVersion: pair.followOnVersion }, status, attempt: { result: `updated to ${pair.followOnVersion}` }, eligibility: { observations: [{ exit: 0, status: { version: pair.targetVersion, update: { automatic: true } } }] } },
    calls: [{ label: 'upgrade under test', argv: ['update', '--self'] }, { label: 'staged scheduler observation', ...status, argv: ['daemon', 'status', '--json'] }],
    nextHop: { followOn: { update: { scheduler: true, exit: 0 } } },
  };
  assert.equal(stagedSchedulerSucceeded(report, pair), true);
  const inPlace = structuredClone(report); inPlace.stagedScheduler.selectedBefore.updateRoute = 'in-place';
  assert.throws(() => stagedSchedulerSucceeded(inPlace, pair));
  const manual = structuredClone(report); manual.calls.push({ label: 'second update', argv: ['update', '--self'] });
  assert.throws(() => stagedSchedulerSucceeded(manual, pair), /manual updater/);
  const absent = structuredClone(report); absent.calls.pop();
  assert.throws(() => stagedSchedulerSucceeded(absent, pair), /missing/);
});
