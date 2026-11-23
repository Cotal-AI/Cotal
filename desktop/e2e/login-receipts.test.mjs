import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { redelivery } from './macos-login-input.mjs';

// Source contracts only. These do not execute Rust or prove native append behavior.
test('debug E2E login writer locks timestamp, complete record and single append together', () => {
  const source = readFileSync(new URL('../src-tauri/src/native_presence.rs', import.meta.url), 'utf8');
  const writer = source.slice(source.indexOf('#[cfg(all(feature = "e2e", debug_assertions))]'), source.indexOf('fn preference_path'));
  assert.match(writer, /#\[cfg\(all\(feature = "e2e", debug_assertions\)\)\]\s*pub fn login_receipt/);
  assert.match(writer, /static RECEIPT_LOCK: Mutex<\(\)> = Mutex::new\(\(\)\);/);
  const ordered = ['RECEIPT_LOCK.lock()', 'SystemTime::now()', 'serde_json::to_vec(', "record.push(b'\\n')", '.append(true)', 'file.write(&record)', 'written == record.len()'];
  let previous = -1;
  for (const token of ordered) {
    const offset = writer.indexOf(token);
    assert.ok(offset > previous, `${token} stays inside the lock and in append order`);
    previous = offset;
  }
  assert.match(writer, /let Ok\(_guard\) = RECEIPT_LOCK.lock\(\) else \{ return; \};/);
  assert.equal((writer.match(/file\.write\(/g) ?? []).length, 1);
  assert.doesNotMatch(writer, /writeln!|write_all|drop\(_guard\)/);
  assert.match(writer, /Ok\(written\) if written == record.len\(\) => \{\},\s*_ => return,/);
});

test('DOM listener and native preference/readback paths share the guarded writer', () => {
  const app = readFileSync(new URL('../src-tauri/src/app.rs', import.meta.url), 'utf8');
  const native = readFileSync(new URL('../src-tauri/src/native_presence.rs', import.meta.url), 'utf8');
  assert.match(app, /app.listen\("desktop-login-input",[\s\S]*?native_presence::login_receipt\("dom-change"/);
  for (const stage of ['handler-enter', 'handler-return', 'api-is-enabled']) assert.ok(native.includes(`login_receipt("${stage}"`));
});

const saved = process.env.COTAL_LOGIN_CORRUPT_RECEIPTS;
for (const platform of ['desktop-account-e2e-macOS-ARM64', 'desktop-account-e2e-macOS-ARM64-macos26']) {
  test(`unchanged strict gate rejects actual run43 corruption: ${platform}`, { skip: !saved && 'set COTAL_LOGIN_CORRUPT_RECEIPTS to preserved run43-attempt1' }, () => {
    const path = join(saved, platform, 'desktop-account-e2e', 'login-preference-receipts.jsonl');
    const lines = readFileSync(path, 'utf8').trimEnd().split('\n');
    const malformed = lines.filter(line => { try { JSON.parse(line); return false; } catch { return true; } });
    assert.equal(malformed.length, 2, 'actual saved interleaved pair remains unchanged');
    // Parsing must fail before cursor identity/time checks. No unsafe admission claim.
    assert.throws(() => redelivery({ path, at: 1 }, 2, Date.now()), SyntaxError);
  });
}
