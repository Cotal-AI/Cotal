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
const durableNames = ['select', 'release-native', 'release-pack', 'release-cells', 'release-summary'];

test('job-only push admits one Windows2022 falsifier and no other job', () => {
  const job = workflow.jobs['windows-job-facts'];
  assert.equal(job['runs-on'], 'windows-2022'); assert.equal(job.strategy, undefined); assert.equal(job.needs, undefined);
  for (const [name, other] of Object.entries(workflow.jobs)) {
    if (durableNames.includes(name)) continue;
    assert(other.if.includes(name === 'windows-job-facts'
      ? "contains(github.event.head_commit.message, '[windows-job-only]')" : "!contains(github.event.head_commit.message, '[windows-job-only]')"), name);
  }
  const install = job.steps.find(x => x.name === 'Install unchanged published native bindings');
  assert(install.run.includes('npm install -g --prefix $prefix cotal-ai@0.164.6'));
  assert(install.run.includes('npm view cotal-ai@0.164.6 dist --json'));
  assert(install.run.includes('20GB'));
  const cell = job.steps.find(x => x.name === 'Scheduled task job-object mutator lifetime falsifier');
  assert.equal(cell.shell, 'powershell'); assert(cell.run.includes('windows-job-facts.ps1 -Output'));
  assert(cell.run.includes('-PackageRoot "$env:PUBLISHED_PACKAGE_ROOT" -Node'));
  assert(!commands(job).includes('--pack') && !commands(job).includes('pnpm build'));
  assert.equal(uses(job, 'actions/upload-artifact')[0].if, 'always()');
});

test('transition mode enables only the three focused jobs and excludes every old job', () => {
  assert.deepEqual(Object.keys(workflow.jobs).filter(name => name.startsWith('transition-')), names);
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (durableNames.includes(name)) continue;
    if (names.includes(name)) {
      assert.equal(job.if, "github.event_name == 'push' && !contains(github.event.head_commit.message, '[windows-job-only]') && !contains(github.event.head_commit.message, '[windows-baseline-only]') && !contains(github.event.head_commit.message, '[mac-controls-only]') && github.event_name == 'push' && contains(github.event.head_commit.message, '[mac-transition-only]') && !contains(github.event.head_commit.message, '[scheduler-only]') && !contains(github.event.head_commit.message, '[installer-only]')");
    } else {
      assert(job.if.includes("!contains(github.event.head_commit.message, '[mac-transition-only]')") || name === 'next-release-macos' && job.if.includes("github.event_name == 'release'"), name);
    }
  }
  assert.equal(native.needs, undefined);
  assert.equal(pack.needs, 'transition-native');
  assert.equal(proof.needs, 'transition-pack');
});

test('controls run only the two unfinished cells with independent disposable custody and no rebuild', () => {
  const job = workflow.jobs['mac-controls-proof'];
  assert.equal(job.needs, undefined);
  assert.equal(job['runs-on'], 'macos-15');
  assert.equal(job.strategy['fail-fast'], false);
  assert.equal(job.strategy['max-parallel'], 1);
  assert.deepEqual(job.strategy.matrix, { mode: ['off-before-tick', 'killed-before-result'] });
  for (const [name, other] of Object.entries(workflow.jobs)) {
    if (durableNames.includes(name)) continue;
    if (name === 'next-release-macos') { assert(other.if.includes("github.event_name == 'release'")); continue; }
    assert(other.if.includes(name === 'mac-controls-proof'
      ? "contains(github.event.head_commit.message, '[mac-controls-only]')"
      : "!contains(github.event.head_commit.message, '[mac-controls-only]')"), name);
  }
  assert(!/--pack|workspace-concurrency|scripts\/build-native/.test(commands(job)));
  const retrieve = job.steps.find(step => step.name === 'Retrieve original candidate without rebuilding');
  assert.equal(retrieve.uses, 'actions/github-script@v8');
  for (const token of ['14084125820', '43521878657', 'e10786970077b6e035606b37a81531a9f35137a8155345e53a275858cd387430', 'getArtifact', 'downloadArtifact', "createHash('sha256')"]) assert(retrieve.with.script.includes(token));
  const verify = job.steps.find(step => step.name === 'Verify original candidate source and manifest');
  assert(verify.run.includes('125e718555b1ec988cf50fcb4b362fb6a775072423466330e670031cb7ec1cb1'));
  assert(verify.run.includes('process.env.PRODUCT_SOURCE'));
  const capture = job.steps.find(step => step.name === 'Capture native launchd manuals before proof cell');
  const cell = job.steps.find(step => step.name === 'Prove isolated scheduler control');
  assert(job.steps.indexOf(capture) < job.steps.indexOf(cell));
  assert.equal(cell.env.PROOF_MODE, '${{ matrix.mode }}');
  assert(cell.run.includes('--launchd-proof "$PROOF_MODE"'));
  const upload = uses(job, 'actions/upload-artifact')[0];
  assert.equal(upload.if, 'always()');
  assert.equal(upload.with.name, 'mac-control-${{ matrix.mode }}');
});

test('Windows push admits only the three native baseline steps and next-release Mac cells cannot run on that push', () => {
  const job = workflow.jobs['windows-baseline'];
  assert.equal(job['runs-on'], 'windows-2022');
  assert.equal(job.needs, undefined);
  assert.equal(job.strategy, undefined);
  for (const [name, other] of Object.entries(workflow.jobs)) {
    if (durableNames.includes(name)) continue;
    if (name === 'windows-baseline') assert(other.if.includes("contains(github.event.head_commit.message, '[windows-baseline-only]')"));
    else if (name === 'next-release-macos') assert(other.if.includes("github.event_name == 'release'"));
    else assert(other.if.includes("!contains(github.event.head_commit.message, '[windows-baseline-only]')"), name);
  }
  const facts = job.steps.find(x => x.name === 'Native one-shot demand task lifecycle facts');
  const policy = job.steps.find(x => x.name === 'Published Windows scheduler policy tick');
  assert(facts.run.includes('windows-task-facts.ps1'));
  assert(policy.run.includes('--source 0.164.6 --layout npm --state daemon --method scheduler --windows-policy-baseline true'));
  assert.equal(policy.if, 'always() && !cancelled()');
  const gate = job.steps.find(x => x.name === 'Native inherited lock lifetime facts');
  assert.equal(gate.if, 'always() && !cancelled()');
  assert(gate.run.includes('windows-gate-facts.ps1'));
  assert(!commands(job).includes('--pack'));
  const next = workflow.jobs['next-release-macos'];
  assert.equal(next['runs-on'], 'macos-15');
  assert.deepEqual(next.strategy.matrix.cell, ['launchd', 'public-installer']);
  assert(commands(next).includes('--source 0.164.6 --layout installer --state daemon --method scheduler --published-launchd true --launchd-proof transition'));
  const publicGet = next.steps.find(x => x.name === 'Upgrade through actual public installer host');
  assert(publicGet.run.includes('--source 0.164.6 --layout installer --state configured --method installer'));
  assert(!publicGet.run.includes('--published-installer') && !publicGet.run.includes('--candidate'));
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
