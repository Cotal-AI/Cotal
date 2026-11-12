import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { startReceiptMirror } from './receipt-mirror.mjs';

test('mirror retains receipts while native journey is still running and stops on cleanup', async () => {
  const root = mkdtempSync(join(tmpdir(), 'receipt-mirror-'));
  const source = join(root, 'source'), output = join(root, 'output');
  const stop = startReceiptMirror(source, output, 5);
  try {
    const receipt = JSON.stringify({ source: 'process-argv', arguments: [{ url: 'cotal://connect', query: '<redacted>' }] }) + '\n';
    writeFileSync(source, receipt);
    const deadline = Date.now() + 2000;
    while (true) {
      try { if (readFileSync(output, 'utf8') === receipt) break; } catch {}
      assert.ok(Date.now() < deadline, 'receipt copied before final cleanup');
      await delay(5);
    }
    stop();
    writeFileSync(source, 'later');
    await delay(25);
    assert.equal(readFileSync(output, 'utf8'), receipt);
  } finally { stop(); rmSync(root, { recursive: true, force: true }); }
});

test('missing receipt diagnostics never prevent original journey', () => {
  const stop = startReceiptMirror('/missing/receipt-source', '/missing/receipt-destination');
  assert.doesNotThrow(stop);
});

test('native timing boundaries distinguish stop, URL launch and renderer delivery', () => {
  const source = readFileSync(new URL('./first-run.ts', import.meta.url), 'utf8');
  const expected = ['phase("disconnected-driver-stop-start")', 'await stopDriver()', 'phase("disconnected-driver-stopped")', 'phase("url-launch-start")', 'await open([link.href])', 'phase("url-launch-opened")', 'await until("deep link visible"', 'phase("url-renderer-prefilled")'];
  let offset = source.indexOf('phase("disconnected-driver-stop-start")');
  for (const step of expected) {
    const next = source.indexOf(step, offset);
    assert.ok(next >= offset, step);
    offset = next + step.length;
  }
  assert.ok(source.indexOf('startReceiptMirror(') < source.indexOf('phase("journey-start")'));
});
