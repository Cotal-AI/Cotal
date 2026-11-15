import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function homebrewOptions(options, { hosted, platform = process.platform } = {}) {
  if (options['homebrew-node'] === undefined) return false;
  assert.equal(options['homebrew-node'], 'true', 'homebrew-node accepts only true');
  assert(hosted && platform === 'darwin' && options.layout === 'npm' && options.state === 'daemon'
    && options.method === 'self' && options['candidate-next'] && options['next-hop-source'] === 'candidate'
    && options['follow-on-action'] === 'self', 'homebrew-node requires hosted macOS npm candidate daemon self with follow-on self');
  return true;
}

/** Resolve the actual Homebrew npm layout, never a private prefix substitute. */
export function homebrewInstallation(env) {
  const clean = { ...env };
  for (const key of Object.keys(clean)) if (key.toLowerCase() === 'npm_config_prefix') delete clean[key];
  const run = (file, args) => execFileSync(file, args, { env: clean, encoding: 'utf8', timeout: 30000 }).trim();
  const prefix = run('brew', ['--prefix']);
  const node = join(prefix, 'bin/node'), npm = join(prefix, 'bin/npm');
  assert.equal(realpathSync(process.execPath), realpathSync(node), 'driver must run on Homebrew Node');
  const npmPrefix = run(npm, ['prefix', '-g']);
  assert.equal(realpathSync(npmPrefix), realpathSync(prefix), 'Homebrew npm must use its real global prefix');
  const modules = run(npm, ['root', '-g']);
  assert.equal(modules, join(npmPrefix, 'lib/node_modules'));
  const lib = lstatSync(dirname(modules));
  assert(lib.isDirectory() && !lib.isSymbolicLink() && lib.uid === process.getuid() && (lib.mode & 0o777) === 0o775,
    'Homebrew lib must already be owner-owned drwxrwxr-x; do not manufacture the condition');
  return { prefix: npmPrefix, modules, node: realpathSync(node), npm: realpathSync(npm), nodeVersion: process.version,
    formula: run('brew', ['list', '--versions', 'node']) };
}

/** Read metadata only. Never follow store symlinks or change package/store permissions. */
export function captureHomebrewState(prefix, stage, uid = process.getuid()) {
  const modules = join(prefix, 'lib/node_modules'), store = join(prefix, 'lib/.cotal-generations');
  const metadata = path => {
    const info = lstatSync(path, { throwIfNoEntry: false });
    return info ? { path, uid: info.uid, mode: info.mode & 0o777, type: info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other' } : null;
  };
  const entries = [];
  const walk = path => {
    const row = metadata(path);
    assert(row, 'store entry disappeared during observation');
    entries.push(row);
    if (row.type === 'directory') {
      row.children = readdirSync(path).sort();
      for (const name of row.children) walk(join(path, name));
    }
  };
  if (metadata(store)) walk(store);
  return { stage, observedAt: new Date().toISOString(), prefix, uid, lib: metadata(dirname(modules)),
    modules: metadata(modules), package: metadata(join(modules, 'cotal-ai')), store, entries };
}

export function archiveHomebrewState({ prefix, stage, output, id }) {
  const state = captureHomebrewState(prefix, stage);
  const bytes = Buffer.from(JSON.stringify(state));
  const artifact = `${id}-homebrew-${stage}.txt`;
  writeFileSync(join(output, artifact), bytes, { flag: 'wx', mode: 0o600 });
  return { artifact, bytes: bytes.length, sha256: digest(bytes) };
}

/** Reopen hash-bound observations rather than trusting the driver's passing flag. */
export function verifyHomebrewEvidence({ report, cell, output }) {
  assert.equal(cell.nodeDistribution, 'homebrew');
  assert.equal(cell.platform, 'darwin');
  assert.equal(cell.followOnAction, 'self');
  const evidence = report.homebrew;
  assert(evidence?.installation?.formula && evidence.installation.nodeVersion);
  const { prefix, modules } = evidence.installation;
  assert.equal(modules, join(prefix, 'lib/node_modules'));
  const stages = ['before-install', 'candidate', 'next', 'follow-on'];
  const calls = [
    report.calls.find(row => row.label === 'install exact candidate source'),
    report.calls.find(row => row.label === 'upgrade under test'),
    report.calls.find(row => row.label === 'candidate follow-on self update under test'),
  ];
  assert(calls.every(row => row?.exit === 0 && row.signal === null && row.timeout === false), 'all three Homebrew install/update commands must succeed');
  assert.deepEqual(calls[0].argv.slice(0, 5), ['install', '-g', '--prefix', prefix, `cotal-ai@${cell.sourceVersion}`]);
  assert.equal(report.candidateSourceInvocation?.path.startsWith(modules + '/cotal-ai/'), true);
  let prior;
  for (const [index, stage] of stages.entries()) {
    const receipt = evidence.observations?.[stage];
    assert.match(receipt?.artifact ?? '', /^[A-Za-z0-9_.-]+\.txt$/);
    const path = join(output, receipt.artifact), stat = lstatSync(path);
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.size === receipt.bytes && stat.size <= 32 * 1024 ** 2);
    const bytes = readFileSync(path);
    assert.equal(digest(bytes), receipt.sha256);
    const state = JSON.parse(bytes);
    assert.equal(state.stage, stage);
    assert.equal(state.prefix, prefix);
    assert.equal(state.lib.path, join(prefix, 'lib'));
    assert.equal(state.lib.type, 'directory');
    assert.equal(state.lib.mode, 0o775, 'group-writable Homebrew lib must stay unchanged');
    assert.equal(state.lib.uid, state.uid);
    const at = Date.parse(state.observedAt);
    assert(Number.isFinite(at) && (!prior || at >= prior));
    if (index === 0) assert(at <= Date.parse(calls[0].startedAt));
    else assert(at >= Date.parse(calls[index - 1].finishedAt));
    if (index < 3) assert(at <= Date.parse(calls[index].startedAt));
    prior = at;
    assert.equal(state.store, join(prefix, 'lib/.cotal-generations'));
    if (index === 0) continue;
    assert.equal(state.package?.path, join(modules, 'cotal-ai'));
    assert.equal(state.package?.type, 'directory');
    if (index >= 2) assert(state.entries.length > 1, 'completed staged update must have a real store');
    const paths = new Set();
    for (const row of state.entries) {
      assert(row.path === state.store || row.path.startsWith(state.store + '/'));
      assert(!paths.has(row.path), 'duplicate store observation'); paths.add(row.path);
      assert.equal(row.uid, state.uid, 'store ownership differs from Homebrew account');
      assert(['directory', 'file', 'symlink'].includes(row.type));
      if (row.type !== 'symlink') assert.equal(row.mode & 0o022, 0, 'generation store has group/other write');
      assert(!/^\.(?:installing|preparing)-/.test(row.path.slice(state.store.length + 1).split('/')[0]), 'abandoned staging directory remains');
    }
    if (state.entries.length) {
      assert(paths.has(state.store), 'store root observation missing');
      assert.equal(state.entries[0].path, state.store);
      assert.equal(state.entries[0].type, 'directory', 'store root must not be a symlink');
      for (const row of state.entries.filter(entry => entry.type === 'directory')) {
        assert(Array.isArray(row.children) && new Set(row.children).size === row.children.length);
        for (const name of row.children) {
          assert(typeof name === 'string' && name !== '.' && name !== '..' && !name.includes('/'));
          assert(paths.has(join(row.path, name)), 'directory child observation omitted');
        }
        const observed = state.entries.filter(entry => dirname(entry.path) === row.path).map(entry => entry.path.slice(row.path.length + 1)).sort();
        assert.deepEqual(observed, [...row.children].sort(), 'directory census differs from observed children');
      }
    }
  }
  return true;
}
