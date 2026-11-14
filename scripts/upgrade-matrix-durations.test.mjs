import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as baseline from './automatic-update-platform-baseline.mjs';

test('only the Windows upgrade command gets the temporary five-minute bound', () => {
  // Published run 43578630881: win32-npm-configured timed out after 181751 ms.
  const recorded = { elapsedMs: 181751, exit: null, timeout: true };
  assert(recorded.timeout && recorded.elapsedMs > 180000);
  for (const platform of ['win32', 'linux', 'darwin']) {
    assert.equal(baseline.callTimeout('upgrade under test', platform), platform === 'win32' ? 300000 : 180000);
    for (const label of ['install published source', 'seed published connectors', 'public installer', 'native status after upgrade']) {
      assert.equal(baseline.callTimeout(label, platform), 180000);
    }
  }
  const source = readFileSync(new URL('./automatic-update-platform-baseline.mjs', import.meta.url), 'utf8');
  assert(source.includes('timeout = callTimeout(label)'));
});

test('summary records update-call elapsedMs for every cell, including failed calls and absence', () => {
  const directory = mkdtempSync(join(tmpdir(), 'upgrade-durations-'));
  try {
    const rows = [
      { id: 'self', method: 'self', calls: [{ label: 'upgrade under test', elapsedMs: 181751, timeout: true }], result: 'failed' },
      { id: 'installer', method: 'installer', calls: [{ label: 'public installer', elapsedMs: 99000 }, { label: 'public installer', elapsedMs: 12598 }], result: 'passed' },
      { id: 'scheduler', method: 'scheduler', calls: [{ label: 'native status', elapsedMs: 20 }], result: 'passed' },
      { id: 'early-failure', method: 'self', calls: [], result: 'failed' },
      { id: 'excluded', method: 'self', result: 'excluded' },
    ];
    for (const row of rows) writeFileSync(join(directory, `${row.id}.json`), JSON.stringify({ tier: 'published', startedAt: '2000-01-01', finishedAt: '2000-01-02', ...row }));
    for (const label of ['public installer', 'receipt-bound published installer', 'candidate source installer']) {
      assert.equal(baseline.updateCallDuration({ method: 'installer', layout: 'installer', calls: [{ label, elapsedMs: 99000 }] }), 'no update call recorded');
      assert.equal(baseline.updateCallDuration({ method: 'installer', layout: 'installer', calls: [{ label: 'public installer', elapsedMs: 99000 }, { label, elapsedMs: 12598 }] }), 12598);
      assert.equal(baseline.updateCallDuration({ method: 'installer', layout: 'npm', calls: [{ label, elapsedMs: 12598 }] }), 12598);
    }
    assert.equal(baseline.updateCallDuration({ id: 'published-first-install', method: 'installer', calls: [{ label: 'receipt-bound published installer', elapsedMs: 6125 }] }), 6125);
    const summary = baseline.summarize(directory);
    const cells = Object.fromEntries(summary.cells.map(row => [row.id, row]));
    assert.equal(cells.self.updateCallDuration, 181751);
    assert.equal(cells.installer.updateCallDuration, 12598);
    assert.equal(cells.scheduler.updateCallDuration, 'scheduler: not a direct update call');
    assert.equal(cells['early-failure'].updateCallDuration, 'no update call recorded');
    assert.equal(cells.excluded.updateCallDuration, 'no update call recorded');
    const markdown = readFileSync(join(directory, 'summary.md'), 'utf8');
    assert(markdown.includes('| Update call duration (ms) |'));
    for (const cell of Object.values(cells)) assert(markdown.includes(`| ${cell.updateCallDuration} |`));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
