import assert from 'node:assert/strict';
import { candidateRegistry, bootstrapVersion } from './automatic-update-platform-baseline.mjs';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { create } from 'tar';
import { parse as parseYaml } from 'yaml';

test('bootstrap versions bracket stable published releases', () => {
  assert.equal(bootstrapVersion('0.164.1', 'B'), '0.164.2');
  assert.equal(bootstrapVersion('0.164.1', 'A'), '0.164.0');
  assert.equal(bootstrapVersion('0.164.0', 'A'), '0.163.0');
  assert.equal(bootstrapVersion('1.0.0', 'A'), '0.0.0');
  assert.throws(() => bootstrapVersion('0.0.0', 'A'));
  assert.throws(() => bootstrapVersion('0.164.2-beta.1', 'B'));
});

test('workflow is priority-first, six-wide and cancels superseded branch runs', () => {
  const workflow = parseYaml(readFileSync(new URL('../.github/workflows/automatic-update-platforms.yml', import.meta.url), 'utf8'));
  assert.equal(workflow.concurrency['cancel-in-progress'], true);
  assert(workflow.concurrency.group.includes('github.ref'));
  assert(workflow.jobs.priority);
  const expanded = workflow.jobs['candidate-B-expanded'];
  assert(expanded.steps.some(step => step.run?.includes('for state in fresh configured stale-extensions recovery concurrent agent')));
  assert.deepEqual(workflow.jobs['candidate-native'].strategy.matrix.source, sources);
  assert.deepEqual(workflow.jobs['candidate-native'].strategy.matrix.method, methods);
  const visiting = new Set(), done = new Set();
  function visit(name) {
    assert(!visiting.has(name), `workflow dependency cycle at ${name}`);
    if (done.has(name)) return;
    const job = workflow.jobs[name];
    assert(job, `unknown dependency ${name}`);
    if (job.strategy) assert(job.strategy['max-parallel'] <= 6, `${name} is not bounded to six`);
    if (name !== 'priority') assert(job.needs, `${name} bypasses priority ordering`);
    visiting.add(name);
    for (const dependency of [job.needs ?? []].flat()) visit(dependency);
    visiting.delete(name);
    done.add(name);
  }
  for (const name of Object.keys(workflow.jobs)) visit(name);
});


test('candidate overlay serves packed closure, stock metadata and read-only policy', async () => {
  const parent = '/var/tmp/upgrade-matrix';
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(parent, 'registry-test-'));
  const names = JSON.parse(readFileSync(new URL('../.changeset/config.json', import.meta.url))).fixed.flat();
  const packages = [];
  for (const [i, name] of names.entries()) {
    const dir = join(root, String(i));
    mkdirSync(join(dir, 'package'), { recursive: true });
    writeFileSync(join(dir, 'package/package.json'), JSON.stringify({ name, version: '0.999.0', type: 'module' }));
    const archive = `${i}.tgz`;
    await create({ cwd: dir, file: join(root, archive), gzip: true }, ['package']);
    packages.push({ name, version: '0.999.0', archive, sha256: createHash('sha256').update(readFileSync(join(root, archive))).digest('hex') });
  }
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({ source: 'a'.repeat(40), packages }));
  const overlay = await candidateRegistry(root, 'B', 'https://registry.npmjs.org/');
  try {
    const metadata = await (await fetch(`${overlay.url}/cotal-ai`)).json();
    assert.equal(metadata['dist-tags'].latest, '0.999.0');
    assert.equal(metadata.versions['0.999.0'].version, '0.999.0');
    const target = await (await fetch(`${overlay.url}/cotal-ai/0.999.0`)).json();
    const archive = Buffer.from(await (await fetch(target.dist.tarball)).arrayBuffer());
    assert.equal(createHash('sha256').update(archive).digest('hex'), packages.find(pkg => pkg.name === 'cotal-ai').sha256);
    assert.equal((await fetch(`${overlay.url}/cotal-ai`, { method: 'PUT', body: '{}' })).status, 405);
  } finally { await overlay.close(); }
  const sourceOverlay = await candidateRegistry(root, 'A', 'https://registry.npmjs.org/');
  try {
    const metadata = await (await fetch(`${sourceOverlay.url}/cotal-ai`)).json();
    assert.notEqual(metadata['dist-tags'].latest, '0.999.0');
    assert.equal(metadata.versions['0.999.0'].version, '0.999.0');
    const installedMetadata = await (await fetch(`${sourceOverlay.url}/cotal-ai/0.999.0`)).json();
    assert(installedMetadata.dist.integrity.startsWith('sha512-'));
  } finally { await sourceOverlay.close(); }
});

import { test } from 'node:test';
import { exclusion, requiresManualStep, sources, states, methods, coordinates } from './automatic-update-platform-baseline.mjs';

test('funding suggestions do not require upgrade intervention', () => {
  assert.equal(requiresManualStep('61 packages are looking for funding\n  run `npm fund` for details\n✓ cotal-ai@0.164.0 installed globally and reconciled'), false);
});
test('actual upgrade remedies and unknown outcomes stay red', () => {
  for (const text of ['run `cotal update --self`', 'Outcome unconfirmed', 'Code: OPERATION_UNKNOWN', 'an interrupted update needs restoration', 'manual intervention']) assert.equal(requiresManualStep(text), true, text);
});
test('matrix includes each requested source, state and method', () => {
  assert.equal(coordinates('linux').length, 252);
  assert.equal(coordinates('linux').filter(cell => !cell.excluded).length, 138);
  assert.equal(coordinates('win32').filter(cell => !cell.excluded).length, 48);
  assert.equal(coordinates('win32').filter(cell => !cell.excluded && cell.layout === 'installer').length, 0);
  assert.deepEqual(sources, ['0.155.0', '0.160.7', '0.162.0', '0.163.5', '0.164.0', 'latest']);
  assert.equal(states.length, 7);
  assert.equal(methods.length, 3);
  assert(exclusion({ layout: 'npm', method: 'installer', state: 'fresh' }));
  assert(exclusion({ layout: 'npm', method: 'scheduler', state: 'fresh' }));
  assert.equal(exclusion({ layout: 'npm', method: 'scheduler', state: 'daemon' }), undefined);
});
