import assert from 'node:assert/strict';
import { candidateRegistry, bootstrapVersion, selectedTargets, cliReportsVersion, verifyCandidateInstaller, completionAdvisory, nativeGenerationReady } from './automatic-update-platform-baseline.mjs';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { create } from 'tar';
import { parse as parseYaml } from 'yaml';

test('old ready daemon verifying installed generation is not target readiness', () => {
  assert(!nativeGenerationReady({ state: 'ready', version: '0.160.7', generation: { installed: '0.164.2', running: '0.160.7', waiting: 'verifying the installed entry' } }, '0.164.2'));
  assert(!nativeGenerationReady(undefined, '0.164.2'));
  assert(nativeGenerationReady({ state: 'ready', version: '0.164.2' }, '0.164.2'));
});

test('only optional shell completion section becomes exact advisory', () => {
  const text = 'Owned shell completion\n  Changed files: 0\n  Preserved integrations: 1\n  powershell: the shell did not return a usable current-user profile\n  Startup files were not rewritten. Run `cotal completion` to inspect local integration.\nRun `cotal update --self` to repair installation.';
  const split = completionAdvisory(text);
  assert(split.advisory.includes('powershell: the shell did not return a usable current-user profile'));
  assert(!split.required.includes('cotal completion'));
  assert(requiresManualStep(split.required));
  assert(!requiresManualStep(completionAdvisory(text.split('\nRun `cotal update')[0]).required));
});

test('candidate installer binds exact bytes and source to packed closure', () => {
  const parent = '/var/tmp/upgrade-matrix';
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(parent, 'installer-proof-'));
  const script = join(root, 'installer.sh'), source = 'a'.repeat(40), bytes = '#!/bin/sh\nexit 0\n';
  writeFileSync(script, bytes);
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({ source }));
  writeFileSync(join(root, 'installer.json'), JSON.stringify({ source, sha256: createHash('sha256').update(bytes).digest('hex') }));
  assert.equal(verifyCandidateInstaller(root, script).source, source);
  writeFileSync(script, '#!/bin/sh\nexit 1\n');
  assert.throws(() => verifyCandidateInstaller(root, script), /differs from packed source receipt/);
});

test('configured version inventory preserves the selected CLI header', () => {
  assert(cliReportsVersion('cotal-ai 0.164.1\n  tmux 0.164.1\n', '0.164.1'));
  assert(!cliReportsVersion('cotal-ai 0.162.0\n  tmux 0.164.1\n', '0.164.1'));
});

test('selected target ignores prior and restored versions in real propagation failure text', () => {
  assert.deepEqual(selectedTargets("cotal-ai@0.163.5 installed\ninstalling cotal-ai@0.164.1 into npm's global installation\nRestoring verified cotal-ai@0.163.5 through the global updater."), ['0.164.1']);
  assert.deepEqual(selectedTargets('updated to 0.164.1'), ['0.164.1']);
  assert.deepEqual(selectedTargets('No newer CLI version; installed package closure is current.'), []);
});

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
  for (const name of ['candidate-pack', 'candidate-B', 'candidate-A', 'candidate-B-expanded']) {
    assert(workflow.jobs[name].if.includes('always()'), `${name} can be suppressed by expected-red priority ancestors`);
    assert(workflow.jobs[name].if.includes("== 'success'"), `${name} must verify its direct predecessor succeeded`);
  }
  assert(workflow.jobs.priority.steps.some(step => step.run?.includes('--stale-version 0.161.1 --method self')));
  const desktop = workflow.jobs['desktop-beside-cli'];
  assert(desktop.steps.some(step => step.with?.['run-id'] === 43456519342 && step.with?.name === 'desktop-release-Linux-X64'));
  assert(desktop.steps.some(step => step.run?.includes('--desktop-runtime') && step.run.includes('--desktop-node')));
  assert.deepEqual(workflow.jobs['candidate-B'].strategy.matrix.source, ['0.164.0']);
  assert.deepEqual(workflow.jobs['candidate-B-expanded'].strategy.matrix.source, sources);
  assert.equal(workflow.jobs['scheduler-proof'].strategy, undefined, 'narrow proof is one runner, not a matrix');
  assert(workflow.jobs['scheduler-proof'].steps.some(step => step.run?.includes('--source 0.160.7 --layout installer --state daemon --method scheduler')));
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (name !== 'scheduler-proof') assert(job.if.includes("!contains(github.event.head_commit.message, '[scheduler-only]')"), `${name} could run during scheduler proof`);
    if (name !== 'installer-proof') assert(job.if.includes("!contains(github.event.head_commit.message, '[installer-only]')"), `${name} could run during installer proof`);
  }
  const installer = workflow.jobs['installer-proof'];
  assert.deepEqual(installer.strategy.matrix.os, ['ubuntu-24.04', 'macos-15']);
  assert.equal(installer.strategy['max-parallel'], 1);
  assert(installer.steps.some(step => step.run?.includes('237e81045f6546e9955ed85b20a073eaae284dd8') && step.run.includes('c0098825508fe4138c811f7f9ccf351b871593167578de35afc77d15d4df323c')));
  assert(installer.steps.some(step => step.run?.includes('for source in 0.164.0 0.160.7') && step.run.includes('--published-installer')));
  assert(installer.steps.some(step => step.run?.includes('--expect-recovery-refusal true') && step.run.includes("runner.os")));
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
    if (!['priority', 'scheduler-proof', 'installer-proof'].includes(name)) assert(job.needs, `${name} bypasses priority ordering`);
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

test('published installer override requires explicit source/hash and cannot enter candidate tiers', async () => {
  const { verifyPublishedInstaller } = await import('./automatic-update-platform-baseline.mjs');
  const parent = '/var/tmp/upgrade-matrix';
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(parent, 'published-script-proof-'));
  const script = join(root, 'install.sh'), source = 'b'.repeat(40), bytes = '#!/bin/sh\nexit 0\n';
  writeFileSync(script, bytes);
  const options = { 'published-installer': script, 'installer-source': source, 'installer-sha256': createHash('sha256').update(bytes).digest('hex'), layout: 'installer', method: 'installer' };
  assert.equal(verifyPublishedInstaller(options).source, source);
  assert.throws(() => verifyPublishedInstaller({ ...options, candidate: root }), /published tier/);
  assert.throws(() => verifyPublishedInstaller({ ...options, layout: 'npm' }), /installer rerun/);
  assert.throws(() => verifyPublishedInstaller({ ...options, 'installer-source': undefined }), /source/);
  writeFileSync(script, '#!/bin/sh\nexit 1\n');
  assert.throws(() => verifyPublishedInstaller(options), /hash/);
});

test('expected recovery refusal stays a failed upgrade and requires exact fail-closed boundary', async () => {
  const { expectedRecoveryRefusal } = await import('./automatic-update-platform-baseline.mjs');
  const report = { update: { exit: 1, stdout: 'Cotal was installed, but reconciliation did not complete.\nRun cotal update --self to finish this update.\n', stderr: 'Outcome unconfirmed\nCode: OPERATION_UNKNOWN\n' }, assertions: [
    { name: 'upgrade exits successfully', passed: false }, { name: 'CLI version is target', passed: true },
    { name: 'no paused recovery record', passed: false }, { name: 'no manual step or refusal', passed: false },
  ], result: 'failed' };
  assert(expectedRecoveryRefusal(report));
  assert.equal(report.result, 'failed');
  assert(!expectedRecoveryRefusal({ ...report, update: { ...report.update, exit: 0 } }));
  assert(!expectedRecoveryRefusal({ ...report, update: { ...report.update, stdout: report.update.stdout + 'Cotal 0.164.0 → 0.164.4\n~/.local/bin/cotal · installed in 2s\n' } }));
  assert(!expectedRecoveryRefusal({ ...report, update: { ...report.update, stderr: 'unrelated failure' } }));
  assert(!expectedRecoveryRefusal({ ...report, assertions: [...report.assertions, { name: 'CLI version is target', passed: false }] }));
});

test('explicit refusal control cannot accept an unexpected successful upgrade', async () => {
  const { cellExitCode } = await import('./automatic-update-platform-baseline.mjs');
  assert.equal(cellExitCode({ result: 'passed', expectedRefusal: { passed: false } }), 1);
  assert.equal(cellExitCode({ result: 'failed', expectedRefusal: { passed: true } }), 0);
  assert.equal(cellExitCode({ result: 'failed', expectedRefusal: { passed: false } }), 1);
  assert.equal(cellExitCode({ result: 'passed' }), 0);
  assert.equal(cellExitCode({ result: 'failed' }), 1);
});

import { test } from 'node:test';
import { exclusion, requiresManualStep, sources, states, methods, coordinates } from './automatic-update-platform-baseline.mjs';

test('funding suggestions do not require upgrade intervention', () => {
  assert.equal(requiresManualStep('61 packages are looking for funding\n  run `npm fund` for details\n✓ cotal-ai@0.164.0 installed globally and reconciled'), false);
});
test('pre-existing installer PATH notice does not require installation repair', () => {
  const notice = 'Your PATH does not select the Cotal just installed.\nUse /private/bin/cotal instead of plain cotal.\nCheck `type -a cotal` in your shell.';
  assert.equal(requiresManualStep(notice), false);
  assert.equal(requiresManualStep(notice + '\nRun `cotal update --self` to repair installation.'), true);
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
