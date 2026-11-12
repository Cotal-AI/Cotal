import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, symlinkSync, mkdtempSync, writeFileSync, appendFileSync, renameSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { baseline, redelivery } from './macos-login-input.mjs';

const row = (atUnixMs, extra = {}) => JSON.stringify({ pid: 42, atUnixMs, stage: 'api-is-enabled', source: 'presence-view', requested: null, ok: true, observed: true, ...extra }) + '\n';
function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'mac-login-'));
  t.after(() => rmSync(home, { recursive: true }));
  const context = join(home, 'context.json'), path = join(home, 'login-preference-receipts.jsonl');
  writeFileSync(context, JSON.stringify({ traceHome: home }));
  const start = Date.now() - 100;
  writeFileSync(path, row(start - 1, { pid: 9 }) + row(start), { mode: 0o600 });
  return { path, cursor: baseline(context, 42), post: start + 1, now: start + 20 };
}
test('fresh owned unchanged poll admits the single redelivery gate', t => {
  const f = fixture(t);
  appendFileSync(f.path, row(f.now));
  assert.equal(redelivery(f.cursor, f.post, f.now), true);
  appendFileSync(f.path, row(f.now + 1, { stage: 'dom-change', source: 'trusted-input' }));
  assert.throws(() => redelivery(f.cursor, f.post, f.now + 1), /input receipt/);
});
for (const extra of [{ stage: 'dom-change', source: 'untrusted-input' }, { source: 'trusted-input' }, { source: 'preference' }, { pid: 99 }, { observed: false }, { atUnixMs: 1 }]) {
  test(`refuses appended ${JSON.stringify(extra)}`, t => {
    const f = fixture(t);
    appendFileSync(f.path, row(f.now, extra));
    assert.throws(() => redelivery(f.cursor, f.post, f.now));
  });
}
for (const mode of ['missing', 'replaced', 'malformed', 'truncated', 'rewritten']) {
  test(`fails closed for ${mode} receipt`, t => {
    const f = fixture(t);
    if (mode === 'missing') rmSync(f.path);
    if (mode === 'replaced') { renameSync(f.path, f.path + '.old'); writeFileSync(f.path, row(f.now)); }
    if (mode === 'malformed') appendFileSync(f.path, '{}\n');
    if (mode === 'truncated') appendFileSync(f.path, '{');
    if (mode === 'rewritten') writeFileSync(f.path, row(f.now));
    assert.throws(() => redelivery(f.cursor, f.post, f.now));
  });
}
test('requires a post-time fresh poll and rejects ambiguous time', t => {
  const f = fixture(t);
  assert.throws(() => redelivery(f.cursor, f.post, f.now));
  appendFileSync(f.path, row(f.now));
  assert.throws(() => redelivery(f.cursor, f.cursor.at, f.now));
  assert.throws(() => redelivery(f.cursor, f.post, f.now + 2001));
});
test('baseline requires a fresh same PID successful unchanged poll', t => {
  const f = fixture(t);
  const context = join(f.path, '..', 'context.json');
  for (const extra of [{ pid: 99 }, { ok: false }, { observed: false }, { source: 'other' }, { atUnixMs: Date.now() - 3000 }]) {
    writeFileSync(f.path, row(Date.now(), extra));
    assert.throws(() => baseline(context, 42));
  }
});
test('unreadable by policy and symlink files are refused', t => {
  const f = fixture(t);
  chmodSync(f.path, 0o666);
  assert.throws(() => redelivery(f.cursor, f.post, f.now));
  chmodSync(f.path, 0o600);
  renameSync(f.path, f.path + '.old');
  symlinkSync(f.path + '.old', f.path);
  assert.throws(() => redelivery(f.cursor, f.post, f.now));
});
test('native source keeps initial unchecked as no-input and gates second delivery after activation', () => {
  const swift = readFileSync(new URL('./macos-driver.swift', import.meta.url), 'utf8');
  assert.match(swift, /if initial.value == 1 \{ press\(initial.element\) \}/);
  assert.match(swift, /native login entry remains after preference change/);
  assert.match(swift, /prepareLoginWindow\(\)/);
  assert.match(swift, /AXUIElementIsAttributeSettable/);
  assert.match(swift, /if attribute\(window, name\) as\? Bool == true \{ continue \}/);
  assert.match(swift, /process.standardError = FileHandle.nullDevice/);
  assert.match(swift, /Darwin.kill\(process.processIdentifier, SIGKILL\)/);
  assert.match(swift, /receipt policy timed out/);
  assert.match(swift, /kAXRaiseAction/);
  assert.match(swift, /AXFocusedWindow/);
  assert.match(swift, /frontmostPID/);
  assert.match(swift, /focusReceipt\("at-post"/);
  assert.match(swift, /receiptPolicy\("baseline", context/);
  assert.match(swift, /receiptPolicy\("check", loginCursor[\s\S]*loginCheckboxState\(\).value == 1[\s\S]*receiptPolicy\("check"/);
  assert.equal((swift.match(/loginDelivery = "redelivery-1"/g) ?? []).length, 1);
  assert.match(swift, /initial-delivery-failure/);
  assert.doesNotMatch(swift, /AXUIElementSetAttributeValue\([^\n]*AXValue/);
});
