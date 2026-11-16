import baseTest from 'node:test';
const test=(name,run)=>baseTest(name,{skip:process.platform==='win32'?'POSIX shared modes only':false},run);
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inspectSharedGenerationModes } from './shared-generation-modes.mjs';
const root = mkdtempSync(join(tmpdir(), 'shared-modes-'));
console.log(`Retained test fixtures: ${root}`);
function fixture(name) {
  const base = join(root, name), pkg = join(base, 'lib/node_modules/cotal-ai');
  const store = join(base, 'lib/.cotal-generations'), generation = join(store, 'a'.repeat(32));
  const descriptor = join(store, `.active-${'b'.repeat(64)}.json`);
  const journal = join(store, '.transaction-c');
  mkdirSync(join(pkg, 'dist'), { recursive: true, mode: 0o755 });
  mkdirSync(generation, { recursive: true, mode: 0o755 });
  for (const path of [store, generation]) chmodSync(path, 0o755);
  const bootstrap = join(pkg, 'dist/cotal.js'), inventory = join(generation, 'inventory.json');
  for (const [path, mode] of [[bootstrap, 0o755], [descriptor, 0o644], [inventory, 0o644]]) {
    writeFileSync(path, '{}', { mode }); chmodSync(path, mode);
  }
  mkdirSync(journal, { mode: 0o700 });
  writeFileSync(join(journal, 'execution.json'), '{}', { mode: 0o600 });
  return { pkg, store, descriptor, bootstrap, inventory, journal };
}

test('shared generation metadata is readable while journals stay private', () => {
  const f = fixture('good'), report = inspectSharedGenerationModes(f.pkg);
  assert.equal(report.passed, true);
  assert.equal(report.generations, 1);
  assert.equal(report.descriptors, 1);
});

test('root-only store permissions fail census', () => {
  const f = fixture('private-store');
  chmodSync(f.store, 0o700);
  const report = inspectSharedGenerationModes(f.pkg);
  assert.equal(report.passed, false);
  assert(report.violations.some(row => row.path === f.store));
});

test('root-only descriptor, inventory and bootstrap cannot pass', () => {
  const f = fixture('private-records');
  chmodSync(f.descriptor, 0o600); chmodSync(f.inventory, 0o600); chmodSync(f.bootstrap, 0o700);
  const report = inspectSharedGenerationModes(f.pkg);
  assert.equal(report.passed, false);
  for (const path of [f.descriptor, f.inventory, f.bootstrap]) assert(report.violations.some(row => row.path === path));
});

test('opening transaction journals to other accounts fails privacy check', () => {
  const f = fixture('public-journal');
  chmodSync(f.journal, 0o755); chmodSync(join(f.journal, 'execution.json'), 0o644);
  assert.equal(inspectSharedGenerationModes(f.pkg).passed, false);
});
