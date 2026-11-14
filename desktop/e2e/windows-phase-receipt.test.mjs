import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { windowsPhaseReceipt } from './windows-phase-receipt.mjs';

function fixture(t) {
  const output = mkdtempSync(join(tmpdir(), 'windows-phase-'));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  return { output, receipt: windowsPhaseReceipt(output, true), rows: () => readFileSync(join(output, 'windows-fixture-phases.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) };
}

test('receipt exists before original native await and identifies an outstanding operation', async t => {
  const f = fixture(t);
  let release, calls = 0;
  const value = { disabled: true, frames: [1], secret: 'private-response' };
  const pending = f.receipt('recovery-before-input-observation', () => {
    calls++;
    assert.deepEqual(f.rows().map(row => row.kind), ['start']);
    return new Promise(resolve => { release = resolve; });
  }, result => ({ disabled: result.disabled, frameCount: result.frames.length }));
  assert.equal(calls, 1);
  assert.deepEqual(f.rows().map(row => row.kind), ['start'], 'no terminal receipt invented for pending call');
  release(value);
  assert.equal(await pending, value);
  const rows = f.rows();
  assert.deepEqual(rows.map(row => row.kind), ['start', 'complete']);
  assert.equal(rows[0].id, rows[1].id);
  assert.deepEqual(rows[1].observation, { disabled: true, frameCount: 1 });
  assert.ok(rows.every(row => row.schema === 1 && Number.isFinite(Date.parse(row.at)) && row.pid === process.pid && row.monotonicMs >= 0));
  assert.doesNotMatch(JSON.stringify(rows), /private-response/);
});

test('failed original native operation rejects identically and records no arbitrary error text', async t => {
  const f = fixture(t);
  const failure = Object.assign(new Error('credential=private-error'), { code: 'ETIMEDOUT' });
  let calls = 0;
  await assert.rejects(f.receipt('cleanup-uninstall', () => { calls++; throw failure; }), error => error === failure);
  assert.equal(calls, 1);
  assert.deepEqual(f.rows().map(row => row.kind), ['start', 'failed']);
  assert.deepEqual(f.rows()[1].error, { name: 'Error', code: 'ETIMEDOUT' });
  assert.doesNotMatch(JSON.stringify(f.rows()), /private-error/);
  const unreadable = Object.defineProperty(new Error('private'), 'code', { get() { throw new Error('metadata'); } });
  await assert.rejects(f.receipt('cleanup-uninstall', () => { throw unreadable; }), error => error === unreadable);
  assert.deepEqual(f.rows().at(-1).error, { name: 'unknown' });
});

test('projection or append failures never retry or replace original operation result', async t => {
  const f = fixture(t);
  let calls = 0;
  assert.equal(await f.receipt('recovery-progress-read', () => ++calls, () => { throw new Error('private'); }), 1);
  assert.deepEqual(f.rows()[1].observation, { status: 'unknown', reason: 'PROJECTION_FAILED' });
  const unavailable = windowsPhaseReceipt(join(f.output, 'missing'), true);
  assert.equal(await unavailable('cleanup-uninstall', () => ++calls), 2);
  const disabled = windowsPhaseReceipt(join(f.output, 'disabled'), false);
  assert.equal(await disabled('cleanup-uninstall', () => ++calls), 3);
});

test('real firstRun brackets unchanged recovery and receipt-owned cleanup calls', () => {
  const source = readFileSync(new URL('./first-run.ts', import.meta.url), 'utf8');
  const recovery = source.slice(source.indexOf('const proveWindowsRestart'), source.indexOf('const browserUrls'));
  for (const phase of ['recovery-restart-helper', 'recovery-before-input-observation', 'recovery-check-again-input', 'recovery-progress-read', 'recovery-setup-settled', 'recovery-refusal-title', 'recovery-authenticated-status', 'recovery-native-verification']) assert.ok(recovery.includes(`windowsPhase("${phase}"`), phase);
  assert.equal(recovery.match(/driver\.click\("recover"\)/g).length, 1);
  assert.equal(recovery.match(/readLifetimeRecord\(/g).length, 1);
  assert.match(recovery, /value\.frames\.slice\(recovery\.before\.frames\.length\).*applications.*unavailable.*!value\.disabled, 1_200_000/);
  for (const phase of ['cleanup-observer-start', 'cleanup-driver-close', 'cleanup-owned-task-stages', 'cleanup-uninstall-dry-run', 'cleanup-uninstall', 'cleanup-endpoint-absence', 'cleanup-native-absence', 'cleanup-user-path-restore', 'cleanup-observer-stop']) assert.ok(source.includes(`windowsPhase("${phase}"`), phase);
  assert.ok(source.indexOf('if (existsSync(receipt))') < source.indexOf('windowsPhase("cleanup-uninstall"'));
  assert.match(source, /check\("cleanup removes app-installed service", removed.state === "removed" && !existsSync\(receipt\)\)/);
  assert.match(source, /native supervisor reports app service absent/);
  assert.match(source, /cleanup restores original account User PATH/);
});
