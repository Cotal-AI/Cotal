import assert from 'node:assert/strict';
import { constants, lstatSync, realpathSync, openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { createHash } from 'node:crypto';

const timestamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(value) && Number.isFinite(Date.parse(value));
function owned(stat) {
  if (process.getuid) {
    assert.equal(stat.uid, process.getuid(), 'foreign owner');
    assert.equal(stat.mode & 0o022, 0, 'group/world writable');
  }
}
function artifact(output, observation, json = true) {
  assert(typeof output === 'string' && resolve(output) === output, 'output must be absolute and normalized');
  assert.equal(realpathSync(output), output, 'symlink output parent');
  const root = lstatSync(output);
  assert(root.isDirectory(), 'output is not a directory');
  owned(root);
  const name = observation.artifact;
  assert(typeof name === 'string' && /^[A-Za-z0-9_.-]+\.txt$/.test(name) && basename(name) === name, 'unsafe artifact name');
  assert(Number.isSafeInteger(observation.bytes) && observation.bytes >= 0 && observation.bytes <= 524288, 'invalid artifact size');
  assert.match(observation.sha256, /^[a-f0-9]{64}$/);
  const path = join(output, name), before = lstatSync(path);
  assert(before.isFile() && !before.isSymbolicLink() && before.nlink === 1, 'not an exclusive regular artifact');
  owned(before);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = fstatSync(fd);
    assert(stat.isFile() && stat.ino === before.ino && stat.dev === before.dev && stat.size === observation.bytes, 'artifact changed or size mismatch');
    const buffer = Buffer.alloc(observation.bytes + 1);
    const count = readSync(fd, buffer, 0, buffer.length, 0);
    assert.equal(count, observation.bytes, 'artifact size mismatch');
    const data = buffer.subarray(0, count);
    assert.equal(createHash('sha256').update(data).digest('hex'), observation.sha256, 'artifact hash mismatch');
    const after = lstatSync(path);
    assert(after.ino === stat.ino && after.dev === stat.dev, 'artifact replaced');
    return json ? JSON.parse(data.toString('utf8')) : data.toString('utf8');
  } finally { closeSync(fd); }
}

/** Grade only independently captured after-update evidence. Never runs commands or reads product paths.
 * Missing recovery records are valid absence. Existing recovery records remain unresolved evidence.
 * Owner records are observations, not kernel-lock custody proof. This never removes stale locks.
 */
export function evaluateManualDaemonState({ diagnostics, output, target, platform } = {}) {
  const checks = [];
  const check = (name, action) => {
    try { const detail = action(); checks.push({ name, passed: true, ...(detail ? { detail } : {}) }); }
    catch (error) { checks.push({ name, passed: false, reason: String(error.message) }); }
  };
  const rows = diagnostics?.observations;
  const row = kind => {
    assert(Array.isArray(rows), 'observations missing');
    const found = rows.filter(item => item.kind === kind);
    assert.equal(found.length, 1, `missing or duplicate ${kind} observation`);
    return found[0];
  };
  const read = kind => artifact(output, row(kind));
  let status, lifetime;
  check('after-update capture', () => {
    assert.equal(diagnostics?.stage, 'after-update');
    assert(timestamp(diagnostics.capturedAt), 'capture timestamp missing');
    assert.equal(row('roots').state, 'observed');
    assert(['linux', 'darwin', 'win32'].includes(platform), 'unsupported platform');
    assert(typeof target === 'string' && target.length > 0, 'target missing');
  });
  check('artifact integrity', () => {
    assert(Array.isArray(rows), 'observations missing');
    for (const observation of rows) if (observation.artifact !== undefined) {
      artifact(output, observation, !['daemon.log', 'daemon.log.1', 'daemon.log.2', 'update-attempt.log'].includes(observation.kind));
    }
  });
  check('public daemon status', () => {
    const observation = row('daemon-status');
    assert.equal(observation.state, 'observed');
    assert.equal(observation.exit, 0);
    const command = read('daemon-status');
    assert.equal(command.exit, 0);
    assert.equal(command.timedOut, false);
    assert.equal(command.truncated, false);
    assert.equal(command.signal, null);
    assert(!command.error, 'status runner error');
    assert(timestamp(command.startedAt) && timestamp(command.finishedAt), 'status timestamps missing');
    assert(Date.parse(command.startedAt) >= Date.parse(diagnostics.capturedAt) && Date.parse(command.finishedAt) >= Date.parse(command.startedAt), 'status timestamp order invalid');
    const value = JSON.parse(command.stdout);
    status = value.result ?? value;
    assert.equal(status.state, 'ready');
    assert.equal(status.version, target);
    assert(Number.isSafeInteger(status.pid) && status.pid > 0, 'status peer PID missing');
  });
  check('native service supervisor', () => {
    assert(status?.state === 'ready', 'public daemon status unavailable');
    const kind = platform === 'linux' ? 'systemctl-show' : platform === 'darwin' ? 'launchctl-print' : 'scheduled-task';
    const observation = row(kind);
    assert.equal(observation.state, 'observed', 'native supervisor unavailable');
    assert.equal(observation.exit, 0);
    const command = read(kind);
    assert.equal(command.exit, 0);
    assert.equal(command.timedOut, false);
    assert.equal(command.truncated, false);
    assert.equal(command.signal, null);
    if (platform === 'linux') {
      const properties = Object.fromEntries(command.stdout.split('\n').filter(Boolean).map(line => { const split = line.indexOf('='); return [line.slice(0, split), line.slice(split + 1)]; }));
      assert.equal(properties.LoadState, 'loaded');
      assert.equal(properties.ActiveState, 'active');
      assert.equal(properties.SubState, 'running');
      assert.equal(properties.UnitFileState, 'enabled');
      assert.equal(Number(properties.MainPID), status.pid, 'native supervisor PID differs from public peer');
    } else if (platform === 'darwin') {
      assert.match(command.stdout, /(?:^|\n)\s*state\s*=\s*running\s*(?:\n|$)/);
      const pid = command.stdout.match(/(?:^|\n)\s*pid\s*=\s*(\d+)/)?.[1];
      const disabledObservation = row('launchctl-disabled');
      assert.equal(disabledObservation.state, 'observed');
      assert.equal(disabledObservation.exit, 0);
      const disabledCommand = read('launchctl-disabled');
      assert.equal(disabledCommand.exit, 0);
      assert.equal(disabledCommand.timedOut, false);
      assert.equal(disabledCommand.truncated, false);
      assert.equal(JSON.parse(disabledCommand.stdout).disabled, false);
      assert.equal(Number(pid), status.pid, 'launchd PID differs from public peer');
    } else {
      const task = JSON.parse(command.stdout);
      assert.equal(task.State, 'Running');
      assert.equal(task.Enabled, true);
    }
  });
  check('installed target version', () => {
    assert.equal(row('installed-version').state, 'archived');
    const installed = read('installed-version');
    assert.equal(installed.name, 'cotal-ai');
    assert.equal(installed.version, target);
    assert.equal(row('installed-version').version, target);
  });
  for (const kind of ['update-recovery.json', 'update-recovery-observed.json']) check(`${kind} absent`, () => {
    assert.equal(row(kind).state, 'missing', 'recovery present, unreadable, or unobserved');
  });
  for (const kind of ['.extensions.lock.update', '.extensions.lock.npm-child', '.cotal-update.lock', '.cotal-update-child']) check(`${kind} inactive`, () => {
    const observation = row(kind);
    if (observation.state === 'missing') return 'owner marker absent';
    assert.equal(observation.state, 'archived', 'owner marker unreadable');
    const owner = read(kind).ownerProcess;
    assert(owner, 'owner liveness unknown');
    assert(owner.state === 'missing' || (owner.state === 'observed' && owner.startMatches === false), 'live or unknown update owner');
    return 'archived owner no longer matches a live process; no lock mutation performed';
  });
  check('ordinary extension lock visibility', () => {
    const observation = row('.extensions.lock');
    assert(['missing', 'archived'].includes(observation.state), 'ordinary extension lock unreadable');
    return 'ordinary lifetime/transient extension lock is not required to be absent';
  });
  check('daemon lifetime owner', () => {
    assert.equal(row('daemon.lock').state, 'archived');
    lifetime = read('daemon.lock');
    assert(status, 'public status unavailable');
    assert.equal(lifetime.record?.pid, status.pid, 'lifetime owner differs from public peer');
    if (platform === 'linux') {
      assert.equal(lifetime.ownerProcess?.state, 'observed');
      assert.equal(lifetime.ownerProcess.startMatches, true);
      assert(!['Z', 'X', 'x'].includes(lifetime.ownerProcess.processState), 'daemon owner not live');
    }
  });
  check('daemon endpoint evidence', () => {
    assert(status?.state === 'ready' && lifetime?.record?.pid === status.pid, 'public peer proof unavailable');
    const observation = row('socket');
    if (platform === 'win32') {
      assert.equal(observation.state, 'unavailable');
      assert(typeof observation.reason === 'string' && observation.reason.includes('named-pipe'), 'explicit pipe limitation missing');
      return `public ready status supplies endpoint peer proof: ${observation.reason}`;
    }
    assert.equal(observation.state, 'archived');
    const socket = read('socket'), recorded = lifetime.record.socket;
    assert(recorded && Number.isSafeInteger(recorded.dev) && Number.isSafeInteger(recorded.ino), 'recorded socket generation missing');
    assert.equal(socket.dev, recorded.dev);
    assert.equal(socket.ino, recorded.ino);
    assert(Number.isFinite(socket.mtimeMs), 'socket timestamp missing');
  });
  return { passed: checks.every(item => item.passed), checks, target, platform, capturedAt: diagnostics?.capturedAt, assertions: ['native-service-manual', 'independent-final-state'] };
}
