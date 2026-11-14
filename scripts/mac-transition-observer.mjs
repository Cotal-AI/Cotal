import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export function validateHandoff(home, receipt, bytes) {
  assert.match(receipt.label, /^ai\.cotal\.update\.[a-f0-9]{32}$/);
  assert.equal(resolve(receipt.source), join(resolve(home), `${receipt.label}.plist`));
  assert.match(receipt.sha256, /^[a-f0-9]{64}$/);
  assert.equal(sha(bytes), receipt.sha256, 'handoff source hash differs from receipt');
  assert(Array.isArray(receipt.argv) && receipt.argv.length === 3 && receipt.argv.every(x => typeof x === 'string'));
  assert.equal(receipt.argv[2], receipt.label);
  assert(Number.isSafeInteger(receipt.failures) && receipt.failures >= 0, 'handoff prior failure budget invalid');
  return receipt;
}

function privateBytes(file, limit = 65536) {
  const stat = lstatSync(file);
  assert(stat.isFile() && !stat.isSymbolicLink(), 'native proof record is not a regular file');
  assert.equal(stat.uid, process.getuid());
  assert.equal(stat.mode & 0o077, 0, 'native proof record is not private');
  assert(stat.size <= limit, 'native proof record exceeds observation bound');
  return readFileSync(file);
}

/** Observe the real handoff without changing its records or loaded job. */
export function observeMacHandoff({ home, daemonHome = join(home, 'daemon'), output, id, native, control, intervalMs = 100 }) {
  assert.equal(process.platform, 'darwin', 'launchd observations require native macOS');
  const domain = `gui/${process.getuid()}`;
  const path = join(output, `${id}-launchd-observations.jsonl`);
  let closed = false, busy = false, sequence = 0, previous, failure, writtenBytes = 0;
  const failures = [];
  const observations = [], labels = new Map();
  async function sample() {
    if (busy || closed) return;
    busy = true;
    try {
      const row = { at: new Date().toISOString(), records: {}, jobs: [] };
      const lock = join(daemonHome, 'daemon.lock');
      for (const name of ['update-launchd.json', 'update-launchd-result.json', 'update-attempt.json', 'update-check.json']) {
        const file = join(home, name);
        try { row.records[name] = JSON.parse(privateBytes(file).toString()); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      const receipt = row.records['update-launchd.json'];
      if (control && !failure) await control.sample(row);
      try {
        row.daemon = JSON.parse(privateBytes(lock, 4096).toString());
        if (row.daemon.pid) {
          row.daemon.birth = native.processStartTime(row.daemon.pid);
          row.daemon.verified = row.daemon.birth === row.daemon.start;
          const parent = spawnSync('/bin/ps', ['-p', String(row.daemon.pid), '-o', 'ppid='], { encoding: 'utf8', timeout: 5000 });
          row.daemon.parent = parent.status === 0 ? Number(parent.stdout.trim()) : undefined;
        }
      } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
      if (receipt) {
        const bytes = privateBytes(receipt.source);
        validateHandoff(home, receipt, bytes);
        labels.set(receipt.label, receipt);
        row.sourceSha256 = sha(bytes);
        row.source = bytes.toString();
      }
      const result = row.records['update-launchd-result.json'];
      if (result) {
        assert(Number.isSafeInteger(result.pid) && result.pid > 1 && typeof result.start === 'string' && typeof result.done === 'boolean');
        row.runnerBirth = native.processStartTime(result.pid);
        row.runnerAlive = row.runnerBirth === result.start;
      }
      for (const [label, known] of labels) {
        const lookup = native.darwinLaunchdJob(label);
        assert.equal(lookup.state === 'unavailable', false, lookup.reason);
        if (lookup.state === 'loaded') {
          assert.equal(lookup.job.label, known.label, 'loaded updater label differs from receipt');
          assert.equal(lookup.job.program, known.argv[0], 'loaded updater program differs from receipt');
          assert.deepEqual(lookup.job.programArguments, known.argv, 'loaded updater argv differs from receipt');
        }
        const listed = spawnSync('/bin/launchctl', ['list'], { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 });
        assert.equal(listed.status, 0, 'native updater list observation failed');
        const printed = spawnSync('/bin/launchctl', ['print', `${domain}/${label}`], { encoding: 'utf8', timeout: 5000 });
        row.jobs.push({ label, lookup, list: { exit: listed.status, stdout: listed.stdout, stderr: listed.stderr }, print: { exit: printed.status, stdout: printed.stdout, stderr: printed.stderr }, sourcePresent: existsSync(known.source) });
      }
      const log = join(home, 'update-attempt.log');
      if (existsSync(log)) {
        const bytes = privateBytes(log, 4 * 1024 * 1024);
        row.updateLogSha256 = sha(bytes);
        writeFileSync(join(output, `${id}-update-attempt-latest.log`), bytes, { mode: 0o600 });
      }
      const key = JSON.stringify({ ...row, at: undefined });
      if (key !== previous) {
        previous = key;
        row.sequence = ++sequence;
        const text = JSON.stringify(row) + '\n';
        writtenBytes += Buffer.byteLength(text);
        assert(writtenBytes <= 16 * 1024 * 1024 && sequence <= 2000, 'native observation evidence budget exceeded');
        observations.push(row);
        appendFileSync(path, text, { mode: 0o600 });
      }
    } catch (error) {
      if (error.code === 'ENOENT') {
        appendFileSync(path, JSON.stringify({ at: new Date().toISOString(), transient: 'handoff files changed during snapshot' }) + '\n', { mode: 0o600 });
        return;
      }
      failure = error.message;
      if (!failures.includes(failure)) {
        failures.push(failure);
        appendFileSync(path, JSON.stringify({ at: new Date().toISOString(), error: failure }) + '\n', { mode: 0o600 });
      }
    } finally { busy = false; }
  }
  const timer = setInterval(() => { void sample(); }, intervalMs);
  return {
    sample,
    observations,
    status: () => ({ failure }),
    async close() {
      clearInterval(timer);
      while (busy) await delay(10);
      await sample();
      closed = true;
      if (control) await control.close();
      const summary = { observations: observations.length, labels: [...labels.values()], failure, failures };
      writeFileSync(join(output, `${id}-launchd-observer.json`), JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
      return summary;
    },
  };
}

export function handoffEvidence(observations, excludedLabel) {
  const labels = [...new Set(observations.map(x => x.records?.['update-launchd.json']?.label).filter(label => label && label !== excludedLabel))];
  let activeObserved = false, completionAndExitObserved = false, retired = false;
  const last = observations.at(-1);
  for (const label of labels) {
    const active = observations.findIndex(x => x.records?.['update-launchd.json']?.label === label && x.records?.['update-launchd-result.json']?.done === false && x.runnerAlive === true && x.jobs?.some(j => j.label === label && j.lookup.state === 'loaded'));
    if (active < 0) continue;
    activeObserved = true;
    const complete = observations.findIndex((x, index) => index > active && x.records?.['update-launchd.json']?.label === label && x.records?.['update-launchd-result.json']?.done === true && x.runnerAlive === false);
    if (complete < 0) continue;
    completionAndExitObserved = true;
    const terminal = last?.jobs?.find(job => job.label === label);
    if (observations.length - 1 > complete && !last.records?.['update-launchd.json'] && !last.records?.['update-launchd-result.json'] && terminal?.lookup.state === 'absent' && !terminal.sourcePresent && last.jobs.every(job => job.lookup.state === 'absent' && !job.sourcePresent)) retired = true;
  }
  return { handoffObserved: labels.length > 0, activeObserved, completionAndExitObserved, retired };
}
