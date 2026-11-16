// Fixed hosted lock generation. No dependency installation or validator imports.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, mkdirSync, writeFileSync, existsSync, cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { acquisitionToolResult } from './ci-validator-lock-acquisition-observation.mjs';
import { assertAcquisitionPreflight } from './ci-validator-lock-acquisition-preflight.mjs';

const pins = Object.freeze({
  'z-schema': '12.5.0',
  '@hyperjump/json-schema': '1.18.0',
  '@hyperjump/browser': '1.5.1',
  'json-schema-library': '11.6.6',
});
const command = Object.freeze([
  '--filter', '@cotal-ai/core', 'add', '--save-dev', '--save-exact', '--lockfile-only',
  '--ignore-scripts', '--config.minimum-release-age=1440', '--config.minimum-release-age-strict=true',
  '--config.minimum-release-age-ignore-missing-time=false', '--config.block-exotic-subdeps=true',
  ...Object.entries(pins).map(([name, version]) => `${name}@${version}`),
]);
const registry = 'https://registry.npmjs.org/';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const maxFileBytes = 8 * 1024 * 1024;
function run(executable, args, cwd = process.cwd()) {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8', timeout: 600_000,
    maxBuffer: maxFileBytes, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } });
  return acquisitionToolResult(result);
}
function git(...args) { return run('git', ['--no-replace-objects', ...args]); }
function file(path) {
  assert.equal(realpathSync(path), path, 'Noncanonical acquisition input');
  const before = lstatSync(path);
  assert.ok(before.isFile() && before.size > 0 && before.size <= maxFileBytes, 'Missing or oversized regular input');
  const bytes = readFileSync(path);
  const after = lstatSync(path);
  assert.equal(after.ino, before.ino);
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(bytes.length, before.size);
  return bytes;
}
function fingerprint(path) {
  const bytes = file(path);
  return { bytes: bytes.length, sha256: sha(bytes) };
}
function config(key) {
  // Query only fixed public policy keys, never all config or auth values.
  const value = run('pnpm', ['config', 'get', key]).trim();
  return value === 'undefined' ? null : value;
}
function emit(path, bytes) {
  assert.ok(bytes.length > 0 && bytes.length <= maxFileBytes, 'Missing or oversized acquisition output');
  writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
}

assert.equal(process.argv.length, 2, 'No command or package inputs are supported');
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Acquisition requires GitHub Actions');
assert.equal(process.env.GITHUB_EVENT_NAME, 'workflow_dispatch', 'Acquisition requires manual dispatch');
assert.equal(process.env.ACQUISITION_MODE, 'validators-0155', 'Unknown acquisition mode');
assert.equal(process.platform, 'linux');
assert.equal(process.arch, 'x64');
assert.match(process.version, /^v22\./);
assert.ok(Number(process.versions.node.split('.')[1]) >= 13, 'pnpm requires Node >=22.13');
assert.match(process.env.GITHUB_SHA ?? '', /^[a-f0-9]{40}$/);
assert.match(process.env.GITHUB_RUN_ID ?? '', /^[1-9][0-9]*$/);
assert.match(process.env.GITHUB_RUN_ATTEMPT ?? '', /^[1-9][0-9]*$/);
assert.equal(process.env.GITHUB_JOB, 'validator-lock-acquisition');
const event = JSON.parse(file(realpathSync(process.env.GITHUB_EVENT_PATH)));
assert.deepEqual(event.inputs, { acquisition: 'validators-0155' }, 'Unknown manual input fields');
// Do not print environment values or inherit package/auth/execution overrides.
assert.ok(!Object.keys(process.env).some(key => /^(npm_config_|pnpm_config_)/i.test(key) ||
  ['NODE_OPTIONS', 'NODE_PATH', 'NODE_AUTH_TOKEN', 'NPM_TOKEN', 'BASH_ENV', 'ENV'].includes(key)),
'Unexpected package, auth or execution environment override');
const root = realpathSync(process.env.GITHUB_WORKSPACE);
assert.equal(realpathSync(process.cwd()), root);
const repositoryWorkspace = file(join(root, 'pnpm-workspace.yaml'));
const reviewedWorkspace = readFileSync(new URL('./ci-validator-acquisition-workspace.yaml', import.meta.url));
const resolve = join(realpathSync(process.env.RUNNER_TEMP), `validator-resolve-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`);
mkdirSync(resolve, { mode: 0o700 }); // EEXIST refuses resolve reuse.
try {
mkdirSync(join(resolve, 'packages', 'core'), { recursive: true });
for (const path of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
  const source = join(root, path);
  if (existsSync(source)) cpSync(source, join(resolve, path));
}
cpSync(join(root, 'packages/core/package.json'), join(resolve, 'packages/core/package.json'));
const workspacePath = join(resolve, 'pnpm-workspace.yaml');
writeFileSync(workspacePath, reviewedWorkspace);
assertAcquisitionPreflight(resolve);
const workspacePin = fingerprint(workspacePath);
assert.equal(git('status', '--porcelain=v1', '--untracked-files=all').trim(), '');
const checkout = git('rev-parse', 'HEAD').trim();
assert.equal(checkout, process.env.GITHUB_SHA);
const tree = git('rev-parse', 'HEAD^{tree}').trim();
const parents = git('show', '-s', '--format=%P', 'HEAD').trim().split(' ').filter(Boolean);
const rootManifest = JSON.parse(file(join(resolve, 'package.json')));
assert.equal(rootManifest.packageManager, 'pnpm@11.28.2');
const paths = git('ls-files', '-z').split('\0').filter(Boolean);
assert.ok(!paths.some(path => /(^|\/)\.?pnpmfile\.(cjs|mjs|js)$/.test(path)), 'Package hooks are not admitted');
assert.ok(!paths.some(path => path.split('/').includes('node_modules')), 'Tracked installed payload is not admitted');
for (const path of paths.filter(path => path.endsWith('package.json'))) {
  const directory = join(resolve, path.slice(0, -'package.json'.length));
  assert.ok(!existsSync(join(directory, 'node_modules')), 'Checkout must not contain installed dependencies');
}
const manifests = new Map(paths.filter(path => path.endsWith('package.json') || path.endsWith('pnpm-lock.yaml') ||
  path.endsWith('.npmrc')).map(path => [path, fingerprint(join(resolve, path))]));
manifests.set('pnpm-workspace.yaml', workspacePin);
assert.ok(manifests.has('packages/core/package.json') && manifests.has('pnpm-lock.yaml'));
for (const path of paths.filter(path => path.endsWith('package.json'))) {
  const scripts = JSON.parse(file(join(resolve, path))).scripts ?? {};
  assert.ok(!Object.hasOwn(scripts, 'pnpm:devPreinstall'), 'Root lifecycle hook is not admitted');
}
assert.equal(run('pnpm', ['--version']).trim(), '11.28.2');
const executablePaths = {};
for (const name of ['node', 'pnpm']) {
  const found = process.env.PATH.split(':').map(directory => join(directory, name)).find(path => existsSync(path));
  assert.ok(found, 'Missing tool executable');
  const canonical = realpathSync(found);
  const toolStat = lstatSync(canonical);
  assert.ok(toolStat.isFile() && toolStat.size > 0 && toolStat.size <= 128 * 1024 * 1024);
  const toolBytes = readFileSync(canonical);
  assert.equal(lstatSync(canonical).mtimeMs, toolStat.mtimeMs);
  assert.equal(toolBytes.length, toolStat.size);
  executablePaths[name] = { path: canonical, bytes: toolBytes.length, sha256: sha(toolBytes) };
}
assert.equal(executablePaths.node.path, realpathSync(process.execPath));
const policy = {};
for (const key of ['registry', '@hyperjump:registry', '@sagold:registry', 'minimum-release-age',
  'minimum-release-age-exclude', 'minimum-release-age-ignore-missing-time', 'minimum-release-age-strict',
  'block-exotic-subdeps', 'ignore-pnpmfile', 'pnpmfile', 'global-pnpmfile', 'allow-builds',
  'trust-policy', 'trust-policy-exclude', 'trust-policy-ignore-after']) policy[key] = config(key);
assert.equal(policy.registry, registry);
for (const key of ['@hyperjump:registry', '@sagold:registry'])
  assert.ok(policy[key] === null || policy[key] === registry, 'Alternate registry is not admitted');
assert.ok(policy['minimum-release-age'] === null || policy['minimum-release-age'] === '1440',
  'Age setting differs from fixed reviewed policy');
for (const key of ['minimum-release-age-exclude', 'trust-policy-exclude'])
  assert.ok(policy[key] === null || policy[key] === '[]', 'Policy exemptions are not admitted');
for (const key of ['pnpmfile', 'global-pnpmfile']) assert.equal(policy[key], null, 'Package hook is not admitted');
assert.ok(policy['ignore-pnpmfile'] === null || policy['ignore-pnpmfile'] === 'false', 'Do not bypass hooks');
assert.ok(policy['block-exotic-subdeps'] === null || policy['block-exotic-subdeps'] === 'true');
const output = join(realpathSync(process.env.RUNNER_TEMP), `validator-lock-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`);
mkdirSync(output, { mode: 0o700 }); // EEXIST refuses output reuse.
const beforeCore = file(join(resolve, 'packages/core/package.json'));
const startedAt = new Date().toISOString();
const log = run('pnpm', command, resolve);
const endedAt = new Date().toISOString();
// Stock pnpm may fetch registry metadata/store data and execute its own resolver/config code.
// lockfileOnly forces ignoreScripts and skips package linking/build paths in 11.28.2.
// This is not an inertness or full installed-graph qualification claim.
console.log(log);
const changed = ['packages/core/package.json', 'pnpm-lock.yaml'];
const before = JSON.parse(beforeCore);
const after = JSON.parse(file(join(resolve, 'packages/core/package.json')));
assert.equal(after.name, '@cotal-ai/core');
const expected = { ...before, devDependencies: { ...before.devDependencies, ...pins } };
assert.deepEqual(after, expected, 'Unexpected manifest edit');
assert.notDeepEqual(fingerprint(join(resolve, 'pnpm-lock.yaml')), manifests.get('pnpm-lock.yaml'), 'Lockfile was not generated');
for (const [path, pin] of manifests) {
  if (changed.includes(path)) continue;
  assert.deepEqual(fingerprint(join(resolve, path)), pin, 'Existing workspace importer or policy changed');
}
for (const path of paths.filter(path => path.endsWith('package.json'))) {
  const directory = join(resolve, path.slice(0, -'package.json'.length));
  if (!existsSync(directory)) continue;
  assert.ok(!existsSync(join(directory, 'node_modules')), 'Dependency materialization is not admitted');
}
assert.equal(git('status', '--porcelain=v1', '--untracked-files=all').trim(), '');
const diff = Buffer.concat(changed.map(path => Buffer.from(`diff --git a/${path} b/${path}\n`)));
const artifacts = {
  'core-package.json': file(join(resolve, 'packages/core/package.json')),
  'pnpm-lock.yaml': file(join(resolve, 'pnpm-lock.yaml')),
  'source.diff': diff,
};
const receipt = {
  kind: 'fixed-validator-lock-acquisition-source-output.v1',
  stage: 'GENERATED_SOURCE_REQUIRES_SEPARATE_WHOLE_GRAPH_REVIEW_NOT_INSTALL_QUALIFICATION',
  checkout, tree, parents, event: 'workflow_dispatch', mode: 'validators-0155',
  run: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT, job: process.env.GITHUB_JOB,
  tools: { node: process.version, pnpm: '11.28.2', platform: process.platform, arch: process.arch, executablePaths },
  policy, effectiveFixedOverrides: { minimumReleaseAge: 1440, minimumReleaseAgeStrict: true,
    minimumReleaseAgeIgnoreMissingTime: false, blockExoticSubdeps: true, ignoreScripts: true },
  command, pins, startedAt, endedAt, acquisitionExit: 0, changed, before: Object.fromEntries(manifests),
  artifacts: Object.fromEntries(Object.entries(artifacts).map(([name, bytes]) => [name, { bytes: bytes.length, sha256: sha(bytes) }])),
  sourceGraph: 'Full generated lock contains importers/packages/snapshots/peer resolutions/integrities. Review all of it separately; not a loaded closure or browser acceptance.',
  unsupportedCapture: 'Original whole native error JSON fidelity remains required. z-schema symbols/undefined unsupported, no normalization or profile narrowing.',
};
for (const [name, bytes] of Object.entries(artifacts)) emit(join(output, name), bytes);
emit(join(output, 'receipt.json'), Buffer.from(JSON.stringify(receipt, null, 2) + '\n'));
assert.ok(repositoryWorkspace.equals(file(join(root, 'pnpm-workspace.yaml'))));
console.log('VALIDATOR LOCK SOURCE OUTPUT COMPLETE: 4 files; separate graph review required');
} finally {
  rmSync(resolve, { recursive: true, force: true });
}
