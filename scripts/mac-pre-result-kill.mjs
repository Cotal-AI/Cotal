import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { validateHandoff } from './mac-transition-observer.mjs';

export const FAILURE = 'launchd updater exited without confirming completion; retrying automatically';
export function parseLaunchctlList(text, label) {
  const rows = text.trim().split(/\r?\n/);
  assert.match(rows.shift() ?? '', /^PID\s+Status\s+Label$/, 'missing documented launchctl header');
  const matches = rows.filter(row => row.trim().split(/\s+/)[2] === label);
  if (!matches.length) return undefined;
  assert.equal(matches.length, 1, 'ambiguous launchctl label');
  const match = /^(\d+|-)\s+(-?\d+)\s+(\S+)$/.exec(matches[0].trim());
  assert(match && match[3] === label, 'invalid launchctl row');
  if (match[1] === '-') return 0;
  const pid = Number(match[1]);
  assert(Number.isSafeInteger(pid) && pid > 1, 'invalid launchctl PID');
  return pid;
}
export function awaitingBootstrap(state, pid) {
  return state === 'absent' && pid === undefined || state === 'loaded' && pid === 0;
}
export function assertFailure(attempt, failures) {
  assert.equal(attempt?.failures, failures + 1, 'failure count changed or counted twice');
  assert.equal(attempt?.result, FAILURE);
}
export function assertRetryBudget(attempt, beforeHandoff) {
  assert(Number.isSafeInteger(attempt?.failures) && attempt.failures >= 0 && attempt.failures <= beforeHandoff + 2, 'retry exceeded one legitimate replacement increment');
}
export function retryClock(before, now) {
  assert(Number.isFinite(before.next), 'missing retry clock');
  return { ...before, next: now - 7200000 };
}
function bytes(file) {
  const stat = lstatSync(file);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid());
  assert.equal(stat.mode & 0o077, 0, 'record is not private');
  assert(stat.size <= 65536, 'record exceeds bound');
  return readFileSync(file);
}
function record(file) {
  try { return JSON.parse(bytes(file).toString()); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}
export function createPreResultKill({ home, native, output, id, daemonPid }) {
  assert.equal(process.platform, 'darwin', 'pre-result kill requires native Darwin');
  assert(Number.isSafeInteger(daemonPid) && daemonPid > 1);
  assert.match(id, /^[a-zA-Z0-9_.-]+$/);
  const attemptPath = join(home, 'update-attempt.json');
  const receiptPath = join(home, 'update-launchd.json');
  const resultPath = join(home, 'update-launchd-result.json');
  const daemonBirth = native.processStartTime(daemonPid);
  assert(typeof daemonBirth === 'string' && daemonBirth.length > 0);
  let stage = 'awaiting-receipt', receipt, pid, birth, stopped = false, killed = false, since, failure;
  const evidence = [];
  function save(event, detail = {}) {
    evidence.push({ event, at: new Date().toISOString(), ...detail });
    const text = JSON.stringify({ stage, receipt, pid, birth, stopped, killed, failure, evidence }, null, 2) + '\n';
    assert(Buffer.byteLength(text) <= 262144 && evidence.length <= 32, 'controller evidence exceeds bound');
    const path = join(output, `${id}-pre-result-kill.json`);
    writeFileSync(path, text, { mode: 0o600, flag: 'w' });
    chmodSync(path, 0o600);
  }
  function list() {
    const result = spawnSync('/bin/launchctl', ['list'], { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, 'launchctl list failed');
    return parseLaunchctlList(result.stdout, receipt.label);
  }
  function noResult() { assert.equal(record(resultPath), undefined, 'capture miss: result already exists'); }
  function identity() {
    assert.deepEqual(record(receiptPath), receipt, 'custody receipt changed');
    validateHandoff(home, receipt, bytes(receipt.source));
    const job = native.darwinLaunchdJob(receipt.label);
    assert.equal(job.state, 'loaded', 'native updater job is not loaded');
    assert.equal(job.job.label, receipt.label);
    assert.equal(job.job.program, receipt.argv[0]);
    assert.deepEqual(job.job.programArguments, receipt.argv);
    assert.equal(list(), pid, 'native runner PID changed');
    assert.equal(native.processStartTime(pid), birth, 'native runner birth changed');
    noResult();
  }
  function resume() {
    if (stopped && !killed && native.processStartTime(pid) === birth) {
      process.kill(pid, 'SIGCONT');
      stopped = false;
    }
  }
  async function sample(observation) {
    if (failure) throw new Error(failure);
    try {
      const current = observation.records?.['update-launchd.json'];
      if (stage === 'awaiting-receipt') {
        if (!current) { assert.equal(receipt, undefined, 'first receipt disappeared before capture'); return; }
        if (receipt) assert.deepEqual(current, receipt, 'first receipt changed before capture');
        else receipt = structuredClone(current);
        noResult();
        assert(Number.isSafeInteger(receipt.failures) && receipt.failures >= 0);
        const job = native.darwinLaunchdJob(receipt.label);
        assert.notEqual(job.state, 'unavailable', 'native capture lookup unavailable');
        pid = list();
        if (awaitingBootstrap(job.state, pid)) { noResult(); return; }
        assert(Number.isSafeInteger(pid) && pid > 1 && pid !== daemonPid);
        birth = native.processStartTime(pid);
        assert(typeof birth === 'string' && birth.length > 0, 'native runner birth unavailable');
        identity();
        assert.equal(native.processStartTime(daemonPid), daemonBirth, 'old daemon changed before capture');
        process.kill(pid, 'SIGSTOP');
        stopped = true;
        assert.equal(native.processStartTime(pid), birth, 'capture miss: runner birth changed');
        noResult();
        stage = 'stopped'; since = performance.now();
        save('runner-stopped');
      } else if (stage === 'stopped') {
        assert.deepEqual(current, receipt, 'stopped receipt disappeared or changed');
        assert.deepEqual(record(receiptPath), receipt, 'stopped custody changed');
        assert.equal(observation.records?.['update-launchd-result.json'], undefined);
        noResult();
        assert.equal(native.processStartTime(daemonPid), daemonBirth, 'old daemon exited or changed');
        assert.equal(native.processStartTime(pid), birth, 'stopped runner changed');
        if (performance.now() - since < 35000) return;
        identity();
        save('fencing-observed', { elapsedMs: performance.now() - since, daemonPid, daemonBirth });
        process.kill(pid, 'SIGKILL');
        killed = true; stopped = false; stage = 'awaiting-exit';
        save('runner-killed');
      } else if (stage === 'awaiting-exit') {
        const found = native.processStartTime(pid); // Lookup errors are failures, never proof of exit.
        assert(found === undefined || found === birth, 'runner PID reused before exit proof');
        if (found !== undefined) return;
        stage = 'awaiting-cleanup'; save('native-exit-confirmed');
      } else if (stage === 'awaiting-cleanup' || stage === 'cooldown') {
        if (current) {
          assert.equal(stage, 'awaiting-cleanup', 'unexpected handoff before retry clock advancement');
          assert.deepEqual(current, receipt, 'unexpected replacement handoff during cleanup');
        }
        noResult();
        const attempt = record(attemptPath);
        assert(attempt && Number.isSafeInteger(attempt.failures) && attempt.failures <= receipt.failures + 1, 'failure counted twice');
        if (stage === 'awaiting-cleanup') {
          const job = native.darwinLaunchdJob(receipt.label);
          assert.notEqual(job.state, 'unavailable', 'native cleanup lookup unavailable');
          if (record(receiptPath) || list() !== undefined || job.state !== 'absent') return;
          try { lstatSync(receipt.source); return; } catch (error) { if (error.code !== 'ENOENT') throw error; }
          assertFailure(attempt, receipt.failures);
          stage = 'cooldown'; since = performance.now(); save('product-cleanup-confirmed', { attempt });
        } else {
          assert.equal(record(receiptPath), undefined);
          assertFailure(attempt, receipt.failures);
          if (performance.now() - since < 35000) return;
          const after = retryClock(attempt, Date.now());
          save('retry-clock', { before: attempt, after, elapsedMs: performance.now() - since });
          writeFileSync(attemptPath, JSON.stringify(after) + '\n', { mode: 0o600 });
          stage = 'awaiting-retry'; save('clock-advanced');
        }
      } else if (stage === 'awaiting-retry') {
        const attempt = record(attemptPath);
        assertRetryBudget(attempt, receipt.failures);
        if (current) {
          assert.notEqual(current.label, receipt.label, 'retry reused killed label');
          if (observation.records?.['update-launchd-result.json']?.done === true) {
            stage = 'retry-completed'; save('retry-completion-observed', { label: current.label });
          }
        }
      }
    } catch (error) {
      failure = error.message;
      try { resume(); } finally { stage = 'failed'; save('failure'); }
      throw error;
    }
  }
  return { sample, status: () => ({ stage, receipt, pid, birth, stopped, killed, failure, evidence: structuredClone(evidence) }), close() { resume(); return this.status(); } };
}
