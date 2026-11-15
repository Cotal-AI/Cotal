import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { archiveHomebrewState, captureHomebrewState, homebrewOptions, verifyHomebrewEvidence } from './homebrew-upgrade-evidence.mjs';
import { boundedCells } from './upgrade-matrix-plan.mjs';

const options = { 'homebrew-node': 'true', layout: 'npm', state: 'daemon', method: 'self', 'candidate-next': '/B', 'next-hop-source': 'candidate', 'follow-on-action': 'self' };
test('Homebrew is explicit and refuses local, non-macOS and non-chain coordinates', () => {
  assert.equal(homebrewOptions({}, { hosted: false, platform: 'linux' }), false);
  assert.equal(homebrewOptions(options, { hosted: true, platform: 'darwin' }), true);
  for (const context of [{ hosted: false, platform: 'darwin' }, { hosted: true, platform: 'linux' }]) assert.throws(() => homebrewOptions(options, context));
  for (const [key, value] of [['homebrew-node', 'false'], ['layout', 'installer'], ['state', 'fresh'], ['method', 'scheduler'], ['next-hop-source', '0.164.10'], ['follow-on-action', 'npm']]) {
    assert.throws(() => homebrewOptions({ ...options, [key]: value }, { hosted: true, platform: 'darwin' }));
  }
});

test('both phases require the Homebrew two-hop, store and native final state proofs', () => {
  for (const phase of ['candidate', 'published']) {
    const cells = boundedCells({ status: 'planned', phase, sourceSHA: 'a'.repeat(40), targetVersion: '0.164.18', sourceVersion: '0.164.17' });
    const rows = cells.filter(cell => cell.nodeDistribution === 'homebrew');
    assert.equal(rows.length, 1);
    const cell = rows[0];
    assert.equal(cell.id, 'darwin-npm-candidate-next-homebrew-self');
    assert.equal(cell.sourceVersion, '0.164.18');
    assert.equal(cell.targetVersion, '0.164.1018');
    assert.equal(cell.finalTargetVersion, '0.164.2018');
    for (const name of ['homebrew-prefix-store', 'follow-on-success', 'next-hop-success', 'independent-final-state', 'extension-versions']) assert(cell.requiredAssertions.includes(name));
  }
});

function fixture() {
  const output = mkdtempSync('/var/tmp/upgrade-matrix/homebrew-evidence-');
  const prefix = join(output, 'brew'), pkg = join(prefix, 'lib/node_modules/cotal-ai');
  mkdirSync(pkg, { recursive: true });
  chmodSync(join(prefix, 'lib'), 0o775);
  const report = { homebrew: { installation: { prefix, modules: join(prefix, 'lib/node_modules'), formula: 'node 25.1.0', nodeVersion: 'v25.1.0' }, observations: {} }, calls: [], candidateSourceInvocation: { path: join(pkg, 'dist/cotal.js') } };
  const cell = { nodeDistribution: 'homebrew', platform: 'darwin', followOnAction: 'self', sourceVersion: '0.164.18' };
  const observe = stage => report.homebrew.observations[stage] = archiveHomebrewState({ prefix, stage, output, id: 'proof' });
  const call = (label, argv) => {
    const now = new Date().toISOString();
    report.calls.push({ label, argv, exit: 0, signal: null, timeout: false, startedAt: now, finishedAt: now });
  };
  observe('before-install');
  call('install exact candidate source', ['install', '-g', '--prefix', prefix, 'cotal-ai@0.164.18']);
  observe('candidate');
  call('upgrade under test', [join(pkg, 'dist/cotal.js'), 'update', '--self']);
  const store = join(prefix, 'lib/.cotal-generations');
  mkdirSync(join(store, 'generation/cotal-ai'), { recursive: true, mode: 0o755 });
  writeFileSync(join(store, 'generation/inventory.json'), '{}', { mode: 0o644 });
  symlinkSync('/does-not-exist', join(store, 'generation/link'));
  observe('next');
  call('candidate follow-on self update under test', [join(pkg, 'dist/cotal.js'), 'update', '--self']);
  observe('follow-on');
  return { report, cell, output, prefix, store };
}

function rewrite(data, stage, change) {
  const receipt = data.report.homebrew.observations[stage];
  const path = join(data.output, receipt.artifact);
  const state = JSON.parse(readFileSync(path));
  change(state);
  const bytes = Buffer.from(JSON.stringify(state));
  writeFileSync(path, bytes);
  receipt.bytes = bytes.length;
  receipt.sha256 = createHash('sha256').update(bytes).digest('hex');
}

test('real filesystem capture keeps symlinks untraversed and accepts readable protected stores', () => {
  const data = fixture();
  assert.equal(verifyHomebrewEvidence(data), true);
  const state = captureHomebrewState(data.prefix, 'inspection');
  assert(state.entries.some(row => row.type === 'symlink'));
  assert(state.entries.some(row => row.mode === 0o644));
  assert.equal(state.lib.mode, 0o775);
});

test('store proof rejects missing stage, changed bytes, writable entries, leftovers and failed hops', () => {
  const cases = [
    data => { delete data.report.homebrew.observations.next; },
    data => { const receipt = data.report.homebrew.observations.next; writeFileSync(join(data.output, receipt.artifact), 'changed'); },
    data => rewrite(data, 'next', state => { state.entries[0].mode = 0o775; }),
    data => rewrite(data, 'follow-on', state => { state.entries[1].path = join(data.store, '.installing-broken'); }),
    data => rewrite(data, 'follow-on', state => { state.entries = []; }),
    data => rewrite(data, 'next', state => { state.entries[0].type = 'symlink'; }),
    data => rewrite(data, 'next', state => { state.entries.pop(); }),
    data => rewrite(data, 'candidate', state => { state.lib.mode = 0o755; }),
    data => rewrite(data, 'next', state => { state.entries[0].uid++; }),
    data => rewrite(data, 'next', state => { state.observedAt = '2020-01-01T00:00:00Z'; }),
    data => { data.report.calls[1].exit = 1; },
    data => { data.report.calls[2].timeout = true; },
    data => { data.report.calls[0].argv[3] = '/private-prefix'; },
  ];
  for (const change of cases) { const data = fixture(); change(data); assert.throws(() => verifyHomebrewEvidence(data)); }
});
