import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { emitSentinel, skipSuite } from '@cotal-ai/smoke-kit';

// Real CLI/natives/npm path. Only the second requested package install is refused by a transparent
// package-manager fixture, so the failure happens after the first connector's ordinary transaction.
if (process.platform === 'win32') {
  skipSuite('update set atomic refusal fixture: not run on Windows, POSIX npm shim required');
} else {
const root = mkdtempSync(join(tmpdir(), 'update-set-'));
try {
const home = join(root, 'home'), config = join(root, 'config'), tools = join(root, 'tools');
for (const dir of [home, config, tools, join(root, '.cotal')]) mkdirSync(dir, { mode: 0o700 });
const bin = resolve('bin/dist/cotal.js');
const generation = (JSON.parse(readFileSync(resolve('bin/package.json'), 'utf8')) as { version: string }).version;
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('COTAL_'))), HOME: home, COTAL_HOME: join(home, '.cotal'), XDG_CONFIG_HOME: config,
  COTAL_ALLOW_CHECKOUT_SEED: '1', COTAL_SKIP_CONNECTOR_SEED: '1', COTAL_NO_UPDATE_CHECK: '1' };
const run = (args: string[], extra = {}) => spawnSync(process.execPath, [bin, ...args], { cwd: root, env: { ...env, ...extra }, encoding: 'utf8', timeout: 120000 });
const seed = run(['ext', 'seed']);
assert.equal(seed.status, 0, seed.stderr);
const key = createHash('sha256').update(bin).digest('hex');
const selectionPath = join(config, 'cotal/installs', key, 'sets', generation, 'selection.json');
const selected = existsSync(selectionPath) ? (JSON.parse(readFileSync(selectionPath, 'utf8')) as { root: string }).root : join(config, 'cotal');
assert.equal(dirname(selected), existsSync(selectionPath) ? dirname(selectionPath) : config);
const prefix = join(selected, 'extensions');
for (const pkg of ['connector-claude-code', 'connector-opencode']) writeFileSync(join(prefix, 'node_modules/@cotal-ai', pkg, 'damage.txt'), 'previous damaged bytes\n');
const digest = (directory: string): string => {
  const hash = createHash('sha256');
  const walk = (dir: string, relative = '') => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name), rel = join(relative, entry.name);
      if (entry.isDirectory()) walk(path, rel);
      else if (entry.isFile()) hash.update(rel).update(readFileSync(path));
    }
  };
  walk(directory); return hash.digest('hex');
};
// Local downloads can disappear after add because extensions are installed as copies.
const missing = ['hello-ext', '@fixture/missing-ext'];
for (const pkg of [...missing, 'kept-ext']) {
  const source = join(root, pkg.replace('/', '-'));
  mkdirSync(source);
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: pkg, version: '1.0.0', type: 'module', main: 'index.js', peerDependencies: { '@cotal-ai/core': '*' } }));
  writeFileSync(join(source, 'index.js'), `import { registry } from '@cotal-ai/core'; registry.register({ kind: 'command', name: '${pkg.split('/').pop()}', summary: 'fixture', async run() {} });\n`);
  const added = run(['ext', 'add', source]);
  assert.equal(added.status, 0, added.stderr);
  rmSync(source, { recursive: true });
}
for (const pkg of missing) rmSync(join(prefix, 'node_modules', pkg), { recursive: true });
const keptBefore = digest(join(prefix, 'node_modules/kept-ext'));
const before = digest(prefix);
const npm = spawnSync('which', ['npm'], { encoding: 'utf8' }).stdout.trim();
assert(npm);
const shim = join(tools, 'npm');
writeFileSync(shim, `#!/bin/sh\ncase "$*" in\n  *install*opencode*) echo 'fixture: second connector unavailable' >&2; exit 1;;\n  *view*cotal-ai@latest*) printf '"${generation}"\\n'; exit 0;;\nesac\nexec ${JSON.stringify(npm)} "$@"\n`);
chmodSync(shim, 0o700);
const updated = run(['update'], { PATH: [tools, process.env.PATH].join(delimiter) });
assert.notEqual(updated.status, 0, 'second package refusal must fail update');
assert.match(updated.stderr, /second connector unavailable/);
assert.equal(digest(prefix), before, 'failed whole-set update must leave live prefix byte-for-byte unchanged');
console.log('whole-set failed update leaves live prefix unchanged');
const repaired = run(['update']);
assert.equal(repaired.status, 0, repaired.stderr);
assert(!readFileSync(join(prefix, 'extensions.json'), 'utf8').includes('undefined'));
for (const pkg of ['connector-claude-code', 'connector-opencode']) assert(!readdirSync(join(prefix, 'node_modules/@cotal-ai', pkg)).includes('damage.txt'));
console.log('whole-set successful update repairs every selected package');
for (const pkg of missing) {
  assert.match(repaired.stderr, new RegExp(`${pkg} is in the extensions manifest but not installed`));
  assert(!existsSync(join(prefix, 'node_modules', pkg)), 'update must not resurrect a missing third-party extension');
  const manifest = JSON.parse(readFileSync(join(prefix, 'extensions.json'), 'utf8')) as { extensions: { pkg: string }[] };
  assert(manifest.extensions.some(entry => entry.pkg === pkg), 'missing extension remains available for explicit repair or removal');
  const lock = JSON.parse(readFileSync(join(prefix, 'package-lock.json'), 'utf8')) as { packages: Record<string, { dependencies?: Record<string, string> }> };
  assert.equal(lock.packages['']?.dependencies?.[pkg], undefined);
  assert.equal(lock.packages[`node_modules/${pkg}`], undefined);
}
assert.equal(digest(join(prefix, 'node_modules/kept-ext')), keptBefore, 'an installed local copy survives even when its source is gone');
for (let attempt = 0; attempt < 2; attempt++) {
  const repeated = run(['update', '--self']);
  assert.equal(repeated.status, 0, repeated.stderr);
}
for (const pkg of missing) {
  const removed = run(['ext', 'remove', pkg]);
  assert.equal(removed.status, 0, removed.stderr);
  assert(!readFileSync(join(prefix, 'extensions.json'), 'utf8').includes(`"${pkg}"`));
}
const repairSeed = run(['ext', 'seed', '--repair']);
assert.equal(repairSeed.status, 0, repairSeed.stderr);
console.log('deleted local extensions do not block update retries, removal or seed repair');
const packageRecord = JSON.parse(readFileSync(join(prefix, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
assert.equal(packageRecord.dependencies['@cotal-ai/connector-claude-code'], `file:../seed/store/${generation}/claude`);

// Let npm finish and the verified prefix promote, then make the authority rename fail.
const authority = join(selected, 'seed/authority.json');
const cursor = join(selected, 'seed/reconcile.cursor.json');
const damage = join(prefix, 'node_modules/@cotal-ai/connector-claude-code/damage.txt');
writeFileSync(damage, 'previous damaged bytes\n');
writeFileSync(shim, `#!/bin/sh
case "$*" in
  *view*cotal-ai@latest*) printf '"${generation}"\\n'; exit 0;;
  *install*claude*)
    ${JSON.stringify(npm)} "$@" || exit $?
    mv ${JSON.stringify(authority)} ${JSON.stringify(authority + '.saved')} && mkdir ${JSON.stringify(authority)}
    exit $?;;
esac
exec ${JSON.stringify(npm)} "$@"
`);
const commitFailure = run(['update'], { PATH: [tools, process.env.PATH].join(delimiter) });
assert.equal(commitFailure.status, 1, commitFailure.stderr);
assert.match(commitFailure.stderr, /rename.*authority\.json/);
assert(!existsSync(damage), 'the verified prefix already promoted');
const retained = readFileSync(cursor, 'utf8');
assert.match(retained, /"failed"/);
rmSync(authority, { recursive: true });
renameSync(authority + '.saved', authority);
const next = run(['space', 'create', 'after-failed-seed'], { COTAL_SKIP_CONNECTOR_SEED: undefined });
assert.notEqual(next.status, 0);
assert.match(next.stderr, /previous connector seed failed/);
assert.equal(readFileSync(cursor, 'utf8'), retained);
console.log('a commit failure after promotion retains the seed cursor and refuses the next command');
emitSentinel({ passed: 4, failed: 0 });
} finally { rmSync(root, { recursive: true, force: true }); }
}
