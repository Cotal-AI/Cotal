import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, symlinkSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { planRelease, verifyResults } from './upgrade-matrix-plan.mjs';
import { verifyTwoHomeUpgrade, verifySelectedGraphs } from './automatic-update-two-homes-evidence.mjs';
import { selectedConnectorRoot, selectionPath } from './automatic-update-two-homes.mjs';

test('two-home POSIX coordinates are required in both release phases and cannot disappear from census', () => {
  for (const phase of ['candidate', 'published']) {
    const plan = planRelease({ eventName: 'workflow_dispatch', inputs: { phase, sourceSHA: 'a'.repeat(40), targetVersion: '0.165.4' } }, { sourceVersion: '0.165.3' });
    const homes = plan.cells.filter(cell => cell.scenario === 'candidate-next-two-homes');
    assert.deepEqual(homes.map(cell => cell.platform), ['linux', 'darwin']);
    assert(homes.every(cell => cell.required && cell.sourceVersion === '0.165.4' && cell.targetVersion === '0.165.1004'));
    for (const cell of homes) for (const name of ['two-home-up', 'two-home-launch', 'old-manager-preserved', 'home-only-remedy', 'owned-stack-cleanup']) assert(cell.requiredAssertions.includes(name));
    const results = plan.cells.filter(cell => cell.required).map(cell => ({ id: cell.id, status: 'passed', assertions: Object.fromEntries(cell.requiredAssertions.map(name => [name, true])) }));
    assert(verifyResults(plan.cells, results).acceptance);
    assert(!verifyResults(plan.cells, results.filter(cell => cell.id !== homes[0].id)).acceptance);
    delete results.find(cell => cell.id === homes[0].id).assertions['old-manager-preserved'];
    assert(!verifyResults(plan.cells, results).acceptance);
  }
});

test('graph evidence requires selected-root and every old byte/link receipt', () => {
  const canonical = '/private/config/cotal', logicalEntry = '/prefix/lib/node_modules/cotal-ai/dist/cotal.js', version = '0.166.1000';
  const path = selectionPath(canonical, logicalEntry, version), selectedRoot = join(dirname(path), 'cotal');
  const rows = [['extensions/extensions.json', 'file', 'a'.repeat(64)], ['extensions/node_modules/core', 'link', '/old/core']];
  const graph = { canonical, oldRoot: canonical, logicalEntry, version, selectionPath: path, selectedRoot, selection: { v: 1, entry: logicalEntry, version, root: selectedRoot }, selected: structuredClone(rows), old: [{ path: canonical, before: structuredClone(rows), after: structuredClone(rows) }] };
  verifySelectedGraphs(graph, version);
  for (const key of ['selectedRoot', 'selection', 'selected', 'old', 'oldRoot', 'canonical', 'logicalEntry']) {
    const missing = structuredClone(graph); delete missing[key];
    assert.throws(() => verifySelectedGraphs(missing, version), key);
  }
  const changed = structuredClone(graph); changed.old[0].after[1][2] = '/new/core';
  assert.throws(() => verifySelectedGraphs(changed, version), /bytes or links changed/);
  const forged = structuredClone(graph); forged.selection.entry = '/other/dist/cotal.js';
  assert.throws(() => verifySelectedGraphs(forged, version), /record differs/);
  const omitted = structuredClone(graph); omitted.oldRoot = '/old/selected/cotal';
  assert.throws(() => verifySelectedGraphs(omitted, version), /old graph checks missing/);
});

test('installed selector requires exact entry/version, private real directories and a private record', () => {
  const canonical = mkdtempSync(join(tmpdir(), 'cotal-selection-'));
  const entry = '/prefix/lib/node_modules/cotal-ai/dist/cotal.js', version = '0.166.1000';
  const path = selectionPath(canonical, entry, version), root = join(dirname(path), 'cotal');
  try {
    assert.equal(selectedConnectorRoot(canonical, entry, version), canonical);
    assert.throws(() => selectedConnectorRoot(canonical, entry, version, true), /receipt missing/);
    for (const name of ['seed', 'extensions']) mkdirSync(join(root, name), { recursive: true, mode: 0o700 });
    const record = { v: 1, entry, version, root };
    const save = value => writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
    save(record);
    assert.equal(selectedConnectorRoot(canonical, entry, version, true), root);
    for (const bad of [{ ...record, entry: '/wrong' }, { ...record, version: '0.166.0' }, { ...record, root: canonical }]) {
      save(bad); assert.throws(() => selectedConnectorRoot(canonical, entry, version, true), /invalid installed selection/);
    }
    save(record); chmodSync(path, 0o644);
    assert.throws(() => selectedConnectorRoot(canonical, entry, version, true), /not private/);
    chmodSync(path, 0o600); chmodSync(root, 0o755);
    assert.throws(() => selectedConnectorRoot(canonical, entry, version, true), /not private/);
    chmodSync(root, 0o700);
    rmSync(join(root, 'seed'), { recursive: true }); symlinkSync(join(root, 'extensions'), join(root, 'seed'));
    assert.throws(() => selectedConnectorRoot(canonical, entry, version, true), /not a real directory/);
    unlinkSync(join(root, 'seed')); mkdirSync(join(root, 'seed'), { mode: 0o700 });
    const other = join(canonical, 'record.json'); save(record);
    writeFileSync(other, JSON.stringify(record), { mode: 0o600 }); unlinkSync(path); symlinkSync(other, path);
    assert.throws(() => selectedConnectorRoot(canonical, entry, version, true), /not private/);
  } finally { rmSync(canonical, { recursive: true, force: true }); }
});

test('workflow downloads paired artifacts, runs actual callable and strict summary grader', () => {
  const workflow = readFileSync(new URL('../.github/workflows/automatic-update-platforms.yml', import.meta.url), 'utf8');
  assert(workflow.includes("matrix.scenario == 'candidate-next-two-homes'"));
  assert(workflow.includes("const { twoHomeUpgrade } = await import('./scripts/automatic-update-two-homes.mjs')"));
  assert(workflow.includes("const verdict = verifyTwoHomeUpgrade(report, { platform: cell.platform, hosted: true })"));
  assert(workflow.includes("report.old.manifestSha256, nextOrigin.sourceManifestSha256"));
  assert(workflow.includes("report.target.manifestSha256, nextOrigin.targetManifestSha256"));
  assert(workflow.includes("report.harnessFiles[name]"));
});

test('incomplete or success-only two-home evidence never grades acceptance', () => {
  for (const value of [undefined, {}, { acceptance: true, cleanup: 'both owned stacks stopped', checks: [] }]) assert.throws(() => verifyTwoHomeUpgrade(value));
});

test('a Linux receipt cannot qualify a Darwin coordinate or pretend to be hosted', () => {
  const report = { platform: 'linux', arch: 'x64', environment: { hostedDisposable: false } };
  assert.throws(() => verifyTwoHomeUpgrade(report, { platform: 'darwin' }), /native platform differs/);
  assert.throws(() => verifyTwoHomeUpgrade(report, { platform: 'linux', hosted: true }), /disposable hosted runner/);
  assert.throws(() => verifyTwoHomeUpgrade({ ...report, arch: undefined }), /architecture required/);
});
