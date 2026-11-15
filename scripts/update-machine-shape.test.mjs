import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { machineShapeOptions, machineShapeCommand } from './update-machine-shape.mjs';

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
