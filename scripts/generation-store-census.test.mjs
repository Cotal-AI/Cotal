import baseTest from 'node:test';
const test = (name, run) => baseTest(name, { skip: process.platform === 'win32' ? 'POSIX generation modes only' : false }, run);
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inspectGenerationStore } from './generation-store-census.mjs';

const parent = tmpdir();
const root = mkdtempSync(join(parent, 'census-'));
console.log(`Retained test fixtures: ${root}`);
const store = name => { const path = join(root, name); mkdirSync(path, { mode: 0o700 }); return path; };

test('settled private tree passes and records each entry', () => {
  const path = store('settled');
  mkdirSync(join(path, 'generation'), { mode: 0o755 });
  writeFileSync(join(path, 'generation', 'inventory.json'), '{}', { mode: 0o644 });
  const report = inspectGenerationStore(path);
  assert.equal(report.passed, true);
  assert.equal(report.state, 'complete');
  assert.equal(report.entries, 3);
});

test('group and other write fail for files and directories', () => {
  const path = store('writable');
  mkdirSync(join(path, 'dir'), { mode: 0o700 });
  chmodSync(join(path, 'dir'), 0o775);
  writeFileSync(join(path, 'file'), 'x', { mode: 0o600 });
  chmodSync(join(path, 'file'), 0o606);
  const report = inspectGenerationStore(path);
  assert.equal(report.passed, false);
  assert.deepEqual(report.violations.map(row => row.path), ['dir', 'file']);
});

test('both staging prefixes fail even when empty and protected', () => {
  const path = store('unfinished');
  mkdirSync(join(path, '.installing-abc123'), { mode: 0o700 });
  mkdirSync(join(path, '.preparing-def456'), { mode: 0o700 });
  const report = inspectGenerationStore(path);
  assert.equal(report.passed, false);
  assert.equal(report.violations.length, 2);
});

test('missing store is accepted only when explicitly optional', () => {
  const path = join(root, 'absent');
  assert.equal(inspectGenerationStore(path).passed, false);
  assert.equal(inspectGenerationStore(path, { required: false }).passed, true);
});

test('never follows a child link or accepts a store link', () => {
  const path = store('linked');
  const target = store('external');
  chmodSync(target, 0o777);
  symlinkSync(target, join(path, 'dependency'), 'dir');
  const report = inspectGenerationStore(path);
  assert.equal(report.passed, true);
  assert.equal(report.entries, 2);
  assert.deepEqual(report.links, [{ path: 'dependency', target }]);
  symlinkSync(path, join(root, 'store-link'), 'dir');
  assert.equal(inspectGenerationStore(join(root, 'store-link')).passed, false);
});

test('entry bound and wrong root type cannot silently pass', () => {
  const path = store('bounded');
  writeFileSync(join(path, 'file'), 'x', { mode: 0o600 });
  assert.equal(inspectGenerationStore(path, { maxEntries: 1 }).state, 'error');
  assert.equal(inspectGenerationStore(join(path, 'file')).passed, false);
  assert.throws(() => inspectGenerationStore(path, { maxEntries: 0 }), /bound/);
});
