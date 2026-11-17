import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./launch.ts', import.meta.url), 'utf8');
test('Mac welcome capture follows the settled accessibility observation without widening acceptance', () => {
  const start = source.indexOf('await until("macOS native metadata and welcome ready"');
  const end = source.indexOf('}, Boolean, 60_000);', start);
  assert(start > 0 && end > start);
  const poll = source.slice(start, end);
  const inspect = poll.indexOf('const accessibility = run("swift"');
  const settled = poll.indexOf('const inspectedAt =');
  const capture = poll.indexOf('run("screencapture"');
  const visual = poll.indexOf('desktop/e2e/welcome.swift');
  assert(inspect >= 0 && settled > inspect && capture > settled && visual > capture);
  assert.match(poll, /accessibility\.toLowerCase\(\)\.includes\("macos"\)/);
  assert.match(poll, /accessibility\.toLowerCase\(\)\.includes\("gb"\)/);
  assert.match(poll, /!accessibility\.toLowerCase\(\)\.includes\("reading computer information"\)/);
  assert.match(poll, /inspectAt, inspectedAt, regionAt, displayAt, capturedAt/);
});
