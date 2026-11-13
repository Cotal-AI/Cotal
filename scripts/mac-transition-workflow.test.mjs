import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';

const text = readFileSync(new URL('../.github/workflows/automatic-update-platforms.yml', import.meta.url), 'utf8');
const workflow = parse(text);
const names = ['transition-native', 'transition-pack', 'transition-mac-proof'];
const [native, pack, proof] = names.map(name => workflow.jobs[name]);
const uses = (job, action) => job.steps.filter(step => step.uses?.startsWith(`${action}@`));
const commands = job => job.steps.map(step => step.run ?? '').join('\n');

test('transition mode enables only the three focused jobs and excludes every old job', () => {
  assert.deepEqual(Object.keys(workflow.jobs).filter(name => name.startsWith('transition-')), names);
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (names.includes(name)) {
      assert.equal(job.if, "github.event_name == 'push' && contains(github.event.head_commit.message, '[mac-transition-only]') && !contains(github.event.head_commit.message, '[scheduler-only]') && !contains(github.event.head_commit.message, '[installer-only]')");
    } else {
      assert(job.if.startsWith("!contains(github.event.head_commit.message, '[mac-transition-only]') && "), name);
    }
  }
  assert.equal(native.needs, undefined);
  assert.equal(pack.needs, 'transition-native');
  assert.equal(proof.needs, 'transition-pack');
});

test('six native builders compile the immutable product checkout with at most three workers', () => {
  assert.equal(workflow.env.PRODUCT_SOURCE, '252d3a03f3550a784c7784efc57155e70a7e5d83');
  assert.equal(native.strategy['max-parallel'], 3);
  assert.equal(native.strategy['fail-fast'], false);
  assert.deepEqual(native.strategy.matrix.include, [
    { platform: 'linux', arch: 'x64', runner: 'ubuntu-24.04' },
    { platform: 'linux', arch: 'arm64', runner: 'ubuntu-24.04-arm' },
    { platform: 'darwin', arch: 'x64', runner: 'macos-15-intel' },
    { platform: 'darwin', arch: 'arm64', runner: 'macos-15' },
    { platform: 'win32', arch: 'x64', runner: 'windows-latest' },
    { platform: 'win32', arch: 'arm64', runner: 'windows-11-arm' },
  ]);
  for (const job of [native, pack]) {
    const checkout = uses(job, 'actions/checkout').find(step => step.with.path === 'product');
    assert.deepEqual(checkout.with, { ref: '${{ env.PRODUCT_SOURCE }}', path: 'product', 'persist-credentials': false });
  }
  for (const step of native.steps.filter(step => step.run)) assert.equal(step['working-directory'], 'product');
  const windows = native.steps.find(step => step.shell === 'cmd');
  assert.equal(windows.if, "matrix.platform == 'win32'");
  for (const token of ['vswhere.exe', 'VsDevCmd.bat', '-host_arch=', 'node packages/workspace/scripts/build-native.mjs', 'node packages/seat/scripts/build-native.mjs --host', 'if errorlevel 1 exit /b 1']) assert(windows.run.includes(token));
  const unix = native.steps.find(step => step.shell === 'bash');
  assert.equal(unix.if, "matrix.platform != 'win32'");
  assert(unix.run.includes("if [ '${{ matrix.platform }}' = darwin ]; then"));
  assert(unix.run.includes('node packages/seat/scripts/build-native.mjs --host'));
  assert(unix.run.includes('node packages/workspace/scripts/build-native.mjs'));
  assert.deepEqual(uses(native, 'actions/upload-artifact').map(step => [step.with.name, step.with.path]), [
    ['transition-seat-${{ matrix.platform }}-${{ matrix.arch }}', 'product/packages/seat/build/Release/${{ matrix.platform }}-${{ matrix.arch }}'],
    ['transition-workspace-${{ matrix.platform }}-${{ matrix.arch }}', 'product/packages/workspace/build/Release/${{ matrix.platform }}-${{ matrix.arch }}'],
  ]);
  assert.equal(uses(native, 'actions/upload-artifact')[1].if, "matrix.platform != 'linux'");
});

test('packer keeps matrix dependencies separate and assembles all product native inputs and guards', () => {
  assert.equal(uses(pack, 'actions/checkout')[0].with.path, undefined);
  assert(pack.steps.some(step => step.run === 'pnpm install --frozen-lockfile --child-concurrency=2' && !step['working-directory']));
  assert(pack.steps.some(step => step.run === 'pnpm install --frozen-lockfile --child-concurrency=2' && step['working-directory'] === 'product'));
  assert(pack.steps.some(step => step.run === 'pnpm --workspace-concurrency 3 build' && step['working-directory'] === 'product'));
  const assembly = pack.steps.find(step => step.name === 'Assemble source-matched full native closure');
  assert.equal(assembly['working-directory'], 'product');
  assert.equal(assembly.env.NATIVE_SOURCE, '${{ env.PRODUCT_SOURCE }}');
  const expected = { NATIVE_SOURCE: '${{ env.PRODUCT_SOURCE }}' };
  for (const platform of ['linux', 'darwin', 'win32']) for (const arch of ['x64', 'arm64']) {
    const suffix = platform === 'linux' ? arch.toUpperCase() : `${platform}_${arch}`.toUpperCase();
    expected[`SEAT_NATIVE_${suffix}`] = '${{ runner.temp }}/transition-natives/' + `transition-seat-${platform}-${arch}/peercred.node`;
    if (platform !== 'linux') expected[`WORKSPACE_NATIVE_${platform === 'win32' ? arch.toUpperCase() : suffix}`] = '${{ runner.temp }}/transition-natives/' + `transition-workspace-${platform}-${arch}`;
  }
  assert.deepEqual(assembly.env, expected);
  assert.deepEqual(assembly.run.trim().split('\n'), [
    'node scripts/seat-assemble-natives.mjs', 'node scripts/workspace-assemble-natives.mjs',
    'node packages/seat/scripts/assert-shipped-natives.mjs', 'node packages/workspace/scripts/assert-shipped-natives.mjs',
  ]);
  assert.equal(uses(pack, 'actions/download-artifact')[0].with.pattern, 'transition-*');
  assert.equal(pack.steps.find(step => step.name === 'Pack candidate A from product source').run,
    'node scripts/automatic-update-platform-baseline.mjs --pack "$RUNNER_TEMP/candidate-A" --version A --source-root "$GITHUB_WORKSPACE/product"');
  assert(!/\b(?:cp|mv|rsync)\b/.test(commands(pack)));
});

test('Mac proof captures full native manuals before exactly three sequential scheduler cells', () => {
  assert.equal(proof['runs-on'], 'macos-15');
  assert.equal(proof.strategy, undefined);
  assert.equal(uses(proof, 'actions/download-artifact')[0].with.name, 'transition-candidate-A');
  assert(proof.steps.some(step => step.run === 'pnpm install --frozen-lockfile --child-concurrency=2'));
  const capture = proof.steps.find(step => step.name === 'Capture native launchd manuals before proof cells');
  for (const token of ['sw_vers', 'uname -a', 'man 5 launchd.plist | col -bx', 'man 1 launchctl | col -bx', 'shasum -a 256', 'test -s']) assert(capture.run.includes(token));
  assert(!commands(proof).includes('../out'));
  const cells = proof.steps.find(step => step.name === 'Prove launchd transition and disabled crash boundaries');
  assert(proof.steps.indexOf(capture) < proof.steps.indexOf(cells));
  assert.deepEqual(cells.run.trim().split('\n'), [
    'set -euo pipefail',
    'for mode in transition off-before-tick killed-before-result; do',
    '  node scripts/automatic-update-platform-baseline.mjs --candidate "$RUNNER_TEMP/candidate-A" --direction A --source latest --layout installer --state daemon --method scheduler --launchd-proof "$mode" --output "$RUNNER_TEMP/upgrade-evidence"',
    'done',
  ]);
  for (const job of [pack, proof]) {
    const uploads = uses(job, 'actions/upload-artifact');
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].if, 'always()');
    assert.equal(uploads[0].with['if-no-files-found'], 'error');
  }
});
