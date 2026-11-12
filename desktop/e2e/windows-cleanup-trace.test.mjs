import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { startCleanupTrace } from './windows-cleanup-trace.mjs';

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'cleanup-trace-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const receipt = join(home, 'service-unit.json');
  const output = join(home, 'windows-cleanup-timings.jsonl');
  await writeFile(receipt, JSON.stringify({ mechanism: 'scheduled-task', unit: 'cotal-daemon-S-1-5-21' }));
  return { home, receipt, output };
}
const rows = async output => (await readFile(output, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
const lock = pid => JSON.stringify({ v: 1, pid, start: String(pid * 10), startedAt: '2026-11-11T11:00:00Z' });

test('observes changed lock lifetimes, overwritten logs and ordered PATH checkpoints without mutating inputs', async t => {
  const f = await fixture(t);
  const calls = [];
  const taskQuery = async (unit, { signal }) => { calls.push(unit); assert.equal(signal.aborted, false); return { present: true, enabled: false, instances: 0, state: 'Ready', secret: 'adapter-secret' }; };
  await writeFile(join(f.home, 'daemon.lock'), lock(123));
  await writeFile(join(f.home, 'daemon.log'), 'old daemon\n');
  const observer = await startCleanupTrace({ ...f, taskQuery });
  t.after(() => observer.stop());
  await writeFile(f.receipt, JSON.stringify({ mechanism: 'scheduled-task', unit: 'cotal-daemon-other' }));
  await observer.checkpoint('before-uninstall');
  await writeFile(join(f.home, 'daemon.lock'), lock(456));
  await writeFile(join(f.home, 'daemon.log'), 'new daemon\n');
  await writeFile(join(f.home, 'native-launcher-stderr.log'), 'launcher failed to open\n');
  await sleep(500);
  await observer.checkpoint('after-uninstall');
  await observer.checkpoint('before-final-PATH-restore');
  await observer.checkpoint('after-final-PATH-restore');
  await observer.stop();
  const result = await rows(f.output);
  assert.deepEqual(result.filter(row => row.kind === 'checkpoint').map(row => row.phase), ['before-uninstall', 'after-uninstall', 'before-final-PATH-restore', 'after-final-PATH-restore']);
  assert.deepEqual(result.filter(row => row.pid).map(row => [row.pid, row.birth]), [[123, '1230'], [456, '4560']]);
  assert.ok(result.some(row => row.text === 'old daemon\n'));
  assert.ok(result.some(row => row.text === 'new daemon\n'));
  assert.ok(result.some(row => row.name === 'native-launcher-stderr.log' && row.text?.includes('launcher failed')));
  assert.ok(calls.every(unit => unit === 'cotal-daemon-S-1-5-21'));
  assert.equal(calls.length, 4, 'continuous samples never query tasks');
  assert.equal(await readFile(join(f.home, 'daemon.lock'), 'utf8'), lock(456));
  assert.equal(await readFile(join(f.home, 'daemon.log'), 'utf8'), 'new daemon\n');
  assert.ok(result.every(row => row.schema === 1 && Number.isFinite(Date.parse(row.at))));
  assert.ok(!(await readFile(f.output, 'utf8')).includes('adapter-secret'));
  const size = (await stat(f.output)).size;
  await sleep(500);
  assert.equal((await stat(f.output)).size, size, 'stop cancels sampler');
  assert.equal((await observer.checkpoint('late')).reason, 'STOPPED');
});

test('bounds logs and lock bytes, redacts sensitive lines and records deletion', async t => {
  const f = await fixture(t);
  await writeFile(join(f.home, 'native-launcher-stderr.log'), 'x'.repeat(10_000) + '\nTOKEN=do-not-keep\nAuthorization: Bearer abc\nENV=private\nordinary failure\n');
  await writeFile(join(f.home, 'daemon.lock'), 'private-secret'.repeat(1000));
  const observer = await startCleanupTrace({ ...f, taskQuery: () => ({ present: false }) });
  t.after(() => observer.stop());
  await rm(join(f.home, 'daemon.lock'));
  await observer.checkpoint('cleanup');
  await observer.stop();
  const text = await readFile(f.output, 'utf8');
  assert.doesNotMatch(text, /do-not-keep|Bearer abc|private-secret|ENV=private/);
  assert.match(text, /ordinary failure/);
  const result = await rows(f.output);
  const stderr = result.find(row => row.name === 'native-launcher-stderr.log');
  assert.equal(stderr.truncated, true);
  assert.equal(stderr.sha256.length, 64);
  assert.ok(stderr.text.length < 8192);
  assert.ok(result.some(row => row.name === 'daemon.lock' && row.status === 'absent'));
});

test('query and output errors are unknown receipts, never escaped or workflow rejections', async t => {
  const f = await fixture(t);
  const observer = await startCleanupTrace({ ...f, taskQuery: () => { throw new Error('secret query dump'); } });
  const result = await observer.checkpoint('cleanup');
  assert.equal(result.task.status, 'unknown');
  await observer.stop();
  assert.doesNotMatch(await readFile(f.output, 'utf8'), /secret query dump/);
  const bad = await startCleanupTrace({ ...f, output: join(f.home, 'missing', 'output'), taskQuery: () => ({ present: true }) });
  assert.equal((await bad.checkpoint('cleanup')).status, 'unknown');
  assert.equal((await bad.stop()).status, 'unknown');
  await mkdir(join(f.home, 'daemon.log'));
  const more = await startCleanupTrace({ ...f, taskQuery: () => ({ present: true }) });
  await more.stop();
  assert.ok((await rows(f.output)).some(row => row.reason === 'NOT_FILE'));
});

test('invalid task names cannot escape into native query; input output collision is refused', async t => {
  const f = await fixture(t);
  await writeFile(f.receipt, JSON.stringify({ mechanism: 'scheduled-task', unit: "cotal-daemon-x'; Remove-Item *" }));
  let calls = 0;
  const observer = await startCleanupTrace({ ...f, taskQuery: () => { calls++; } });
  assert.equal((await observer.checkpoint('cleanup')).task.reason, 'NO_OWNED_TASK');
  await observer.stop();
  assert.equal(calls, 0);
  const before = await readFile(f.receipt, 'utf8');
  const collision = await startCleanupTrace({ ...f, output: f.receipt });
  assert.equal((await collision.checkpoint('cleanup')).reason, 'OUTPUT_IS_INPUT');
  await collision.stop();
  assert.equal(await readFile(f.receipt, 'utf8'), before);
});

test('hung query is bounded and abort signal delivered, stop leaves no sampler', async t => {
  const f = await fixture(t);
  let signal;
  const observer = await startCleanupTrace({ ...f, taskQuery: (_unit, options) => { signal = options.signal; return new Promise(() => {}); } });
  const pending = observer.checkpoint('cleanup');
  await sleep(50);
  await writeFile(join(f.home, 'daemon.lock'), lock(999));
  await sleep(500);
  assert.ok((await rows(f.output)).some(row => row.pid === 999), 'filesystem sampling continues during native query');
  const stopping = observer.stop();
  const result = await pending;
  await stopping;
  assert.equal(result.task.reason, 'QUERY_TIMEOUT');
  assert.equal(signal.aborted, true);
  const size = (await stat(f.output)).size;
  await sleep(400);
  assert.equal((await stat(f.output)).size, size);
});
