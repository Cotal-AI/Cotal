import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import { auditPackage, packageName, runtimeDependencyExemption, runtimeImports } from './check-runtime-dependencies.mjs';

test('emitted runtime imports include import, re-export, dynamic import and require', () => {
  const js = ts.transpileModule(`import type { A } from 'type-only';
import { B } from '@scope/runtime/subpath';
export { B as C } from 're-export';
void import('late/subpath');
const x = require('common');
require.resolve('resolved');
import.meta.resolve('esm-resolved');
console.log(B, x);`, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  assert.deepEqual(runtimeImports(js).map(row => row.specifier), ['@scope/runtime/subpath', 're-export', 'late/subpath', 'common', 'resolved', 'esm-resolved']);
});

test('source-launch loader classification matches only its published Jcode file and specifier', () => {
  assert.match(runtimeDependencyExemption('@cotal-ai/connector-jcode', 'dist/index.js', 'tsx'), /source-launch branch/);
  for (const [name, file, specifier] of [
    ['@cotal-ai/connector-core', 'dist/index.js', 'tsx'],
    ['@cotal-ai/connector-jcode', 'dist/host.js', 'tsx'],
    ['@cotal-ai/connector-jcode', 'dist/index.js', 'tsx/cli'],
  ]) assert.equal(runtimeDependencyExemption(name, file, specifier), undefined);
});

test('built-ins, file URLs, relative paths and self imports are not npm dependencies', () => {
  for (const specifier of ['node:fs', 'fs/promises', './local.js', '../local.js', '/absolute/file.js', 'file:///module.js', '#local']) assert.equal(packageName(specifier), undefined);
  assert.equal(packageName('@scope/name/entry'), '@scope/name');
  assert.equal(packageName('name/entry'), 'name');
});

test('auditor rejects dev-only, optional-only and unknown computed loads in built output', () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-deps-'));
  try {
    mkdirSync(join(root, 'dist'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@test/package', dependencies: { declared: '1' }, peerDependencies: { peer: '*' }, devDependencies: { missing: '1' }, optionalDependencies: { optional: '1' } }));
    writeFileSync(join(root, 'dist', 'entry.js'), `import 'declared'; export * from 'peer/entry'; import '@test/package'; import 'missing'; import 'optional'; import(supplied);`);
    assert.deepEqual(auditPackage(root).violations.map(row => row.dependency), ['missing', 'optional', '<computed load requires classification>']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('missing or unparsable built output refuses instead of an empty audit', () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-deps-'));
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@test/package' }));
    assert.throws(() => auditPackage(root), /dist is missing/);
    mkdirSync(join(root, 'dist'));
    assert.throws(() => auditPackage(root), /no emitted JavaScript/);
    writeFileSync(join(root, 'dist', 'entry.js'), 'import {');
    assert.throws(() => auditPackage(root), /did not parse/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
