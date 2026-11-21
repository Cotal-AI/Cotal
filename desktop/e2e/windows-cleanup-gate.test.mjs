import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseDocument } from 'yaml';
import * as journey from './windows-journey.mjs';

const required = ['cleanup removes app-installed service', 'native supervisor reports app service absent', 'cleanup restores original account User PATH'];

test('a failed link tail does not gate cell 2 on the whole cell 1 outcome', () => {
  const steps = parseDocument(readFileSync(new URL('../../.github/workflows/desktop.yml', import.meta.url), 'utf8')).toJS().jobs['native-build'].steps;
  const next = steps.find(step => step.id === 'windows-after-start');
  assert.equal(next.if, "!cancelled() && runner.os == 'Windows' && steps.windows-before-cleanup.outputs.clean == 'true'");
  const cleanup = steps.find(step => step.id === 'windows-before-cleanup');
  assert.ok(cleanup);
  assert.match(cleanup.if, /!cancelled\(\)/);
  assert.match(cleanup.run, /windows-journey\.mjs verify-cleanup/);
  assert.ok(cleanup.run.indexOf('if ($LASTEXITCODE -ne 0)') < cleanup.run.indexOf('clean=true'));
  assert.ok(!steps.find(step => step.id === 'windows-before-finish')['continue-on-error'], 'link failure must remain red');
});

test('cleanup gate accepts failed journey only after original native cleanup and fixture exit', () => {
  assert.equal(typeof journey.verifyCleanup, 'function');
  const root = mkdtempSync(join(tmpdir(), 'cleanup-gate-'));
  const directory = join(root, 'private'), output = join(root, 'output');
  mkdirSync(directory); mkdirSync(output);
  const write = (controller, checks = required, exit = { kind: 'fixture-exit', code: 1, signal: null }) => {
    writeFileSync(join(directory, 'result.json'), JSON.stringify(controller));
    writeFileSync(join(output, 'result.json'), JSON.stringify({ checks, outcome: 'failed', failure: 'owned app plain process argument timed out: false' }));
    writeFileSync(join(output, 'windows-journey-phases.jsonl'), JSON.stringify(exit) + '\n');
  };
  const done = { schema: 1, state: 'done', code: 1, cancelled: false };
  write(done);
  assert.doesNotThrow(() => journey.verifyCleanup(directory, output));
  for (const missing of required) {
    write(done, required.filter(row => row !== missing));
    assert.throws(() => journey.verifyCleanup(directory, output));
  }
  for (const controller of [{ ...done, state: 'service-tail' }, { ...done, cancelled: true }]) {
    write(controller);
    assert.throws(() => journey.verifyCleanup(directory, output));
  }
  for (const exit of [{ kind: 'fixture-progress', code: 1, signal: null }, { kind: 'fixture-exit', code: 1, signal: 'SIGTERM' }]) {
    write(done, required, exit);
    assert.throws(() => journey.verifyCleanup(directory, output));
  }
});
