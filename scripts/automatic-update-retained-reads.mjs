/** Public A -> self-update B -> npm replacement C regression. No services or stacks are started. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { candidateRegistry } from './automatic-update-platform-baseline.mjs';
import { compareVersions } from './upgrade-matrix-plan.mjs';

export async function automaticUpdateRetainedReads(A, B, C, newPrivateRoot, mode = 'normal') {
  assert(A && B && C && newPrivateRoot, 'usage: <A-normal-packed-closure> <B-normal-packed-closure> <C-normal-packed-closure> <new-private-root>');
  assert(['normal', 'pending-promotion'].includes(mode), 'unsupported retained-read mode');
  assert(['linux', 'darwin'].includes(process.platform), 'npm retained selection requires a Unix host');
  const root = resolve(newPrivateRoot); assert(!existsSync(root), 'private root must be new'); mkdirSync(root, { mode: 0o700 });
  const report = { root, passed: false, calls: [], candidates: [], servicesStarted: false }, overlays = [];
  const hash = bytes => createHash('sha256').update(bytes).digest('hex'), json = file => JSON.parse(readFileSync(file, 'utf8'));
  const save = () => writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  const prefix = join(root, 'prefix'), entry = join(prefix, 'bin/cotal'), config = join(root, 'config/cotal');
  for (const dir of ['home', 'config', 'cotal', 'runtime', 'tmp', 'cache', 'data', 'state', 'project']) mkdirSync(join(root, dir), { mode: 0o700 });
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(COTAL_|XDG_|npm_|NPM_|NODE_OPTIONS$|NODE_PATH$|HOME$|.*(?:TOKEN|PASSWORD|SECRET|CREDENTIAL).*$)/i.test(k)));
  Object.assign(env, { HOME: join(root, 'home'), COTAL_HOME: join(root, 'cotal'), XDG_CONFIG_HOME: join(root, 'config'),
    XDG_RUNTIME_DIR: join(root, 'runtime'), XDG_CACHE_HOME: join(root, 'cache'), XDG_DATA_HOME: join(root, 'data'), XDG_STATE_HOME: join(root, 'state'), TMPDIR: join(root, 'tmp'),
    PATH: [join(prefix, 'bin'), dirname(process.execPath), env.PATH].filter(Boolean).join(delimiter), npm_config_prefix: prefix,
    npm_config_cache: join(root, 'cache/npm'), npm_config_userconfig: join(root, 'npmrc'), npm_config_globalconfig: join(root, 'global-npmrc'),
    npm_config_audit: 'false', npm_config_fund: 'false', DO_NOT_TRACK: '1', COTAL_TELEMETRY: 'off', NO_COLOR: '1' });
  for (const name of ['npmrc', 'global-npmrc']) writeFileSync(join(root, name), '', { mode: 0o600 });
  async function call(label, file, args) {
    console.log('JCODE_PROGRESS ' + JSON.stringify({ message: label }));
    const record = { label, file, args, registry: env.npm_config_registry, cwd: join(root, 'project'), stdout: '', stderr: '', startedAt: new Date().toISOString() };
    report.calls.push(record); save();
    await new Promise(done => {
      const child = spawn(file, args, { cwd: record.cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const timer = setTimeout(() => { record.timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 240000);
      child.stdout.on('data', b => { record.stdout += b; }); child.stderr.on('data', b => { record.stderr += b; });
      child.once('error', error => { record.error = error.message; clearTimeout(timer); done(); });
      child.once('close', (code, signal) => { Object.assign(record, { code, signal }); clearTimeout(timer); done(); });
    });
    record.finishedAt = new Date().toISOString(); save(); return record;
  }
  const cli = (label, args) => call(label, process.execPath, [entry, ...args]);
  const ok = r => { assert.equal(r.code, 0, JSON.stringify(r)); assert(!r.error && !r.signal && !r.timedOut); return r; };
  function snapshot(base) {
    const result = {};
    function walk(path, relative) {
      if (!existsSync(path) && !lstatSync(path, { throwIfNoEntry: false })) return;
      const s = lstatSync(path, { bigint: true }), row = {};
      for (const k of ['mode', 'uid', 'gid', 'size', 'ino', 'dev', 'nlink', 'mtimeNs', 'ctimeNs', 'birthtimeNs']) row[k] = String(s[k]);
      if (s.isSymbolicLink()) row.link = readlinkSync(path);
      else if (s.isFile()) { const bytes = readFileSync(path); row.sha256 = hash(bytes); }
      result[relative] = row;
      if (s.isDirectory()) for (const name of readdirSync(path).sort()) walk(join(path, name), relative ? `${relative}/${name}` : name);
    }
    walk(base, ''); return result;
  }
  function selection(version) {
    const logicalEntry = realpathSync(entry), sets = join(config, 'installs', hash(logicalEntry), 'sets');
    const currentPath = join(sets, 'current.json'), selectionPath = join(sets, version, 'selection.json');
    const current = json(currentPath), selected = json(selectionPath), expected = { v: 1, entry: logicalEntry, version, root: join(sets, version, 'cotal') };
    const evidence = { logicalEntry, currentPath, selectionPath, current, selected }; report.selectors ??= []; report.selectors.push(evidence); save();
    for (const record of [current, selected]) for (const [key, value] of Object.entries(expected)) assert.equal(record[key], value, `${key} in selection`);
    return evidence;
  }
  try {
    for (const [directory, direction] of [[A, 'A'], [B, 'B'], [C, 'B']]) {
      const overlay = await candidateRegistry(resolve(directory), direction, 'https://registry.npmjs.org/'); overlays.push(overlay);
      report.candidates.push({ directory: resolve(directory), url: overlay.url, ...overlay.identity }); save();
    }
    const [a, b, c] = overlays.map(o => o.identity.version);
    assert.equal(new Set(overlays.map(o => o.url)).size, 3);
    assert.match(overlays[0].identity.source, /^[a-f0-9]{40}$/);
    assert(overlays.every(o => o.identity.source === overlays[0].identity.source), 'all closures must share one HEAD');
    assert(compareVersions(b, a) > 0 && compareVersions(c, b) > 0, 'versions must increase A < B < C');
    env.npm_config_registry = overlays[0].url;
    ok(await call('install-A', 'npm', ['install', '-g', `cotal-ai@${a}`]));
    ok(await cli('seed-A', ['ext', 'seed'])); ok(await cli('add-tmux-A', ['ext', 'add', `@cotal-ai/tmux@${a}`]));
    env.npm_config_registry = overlays[1].url; ok(await cli('self-update-B', ['update', '--self']));
    const previous = selection(b); report.previousInventory = snapshot(previous.selected.root); save();
    if (mode === 'pending-promotion') {
      const hook = join(root, 'crash.cjs');
      writeFileSync(hook, "const fs=require('node:fs');const {syncBuiltinESMExports}=require('node:module');const rename=fs.renameSync;fs.renameSync=function(from,to){const value=rename.apply(this,arguments);if(String(from).endsWith('.ready')&&String(to).endsWith('extensions'))process.kill(process.pid,'SIGKILL');return value;};syncBuiltinESMExports();", { mode: 0o600 });
      env.NODE_OPTIONS = `--require=${hook}`;
      const crashed = await cli('interrupt-B-promotion', ['ext', 'add', `@cotal-ai/tmux@${b}`]);
      delete env.NODE_OPTIONS;
      assert.equal(crashed.signal, 'SIGKILL', 'actual public B mutation must reach promotion');
      assert(existsSync(join(previous.selected.root, '.extensions-promotion.json')), 'actual promotion must leave its recovery journal');
    }
    env.npm_config_registry = overlays[2].url; ok(await call('bare-install-C', 'npm', ['install', '-g', `cotal-ai@${c}`]));
    report.before = snapshot(config); save();
    const version = await cli('read-version', ['--version']), ext = await cli('read-ext', ['ext', '--json']), runtimes = await cli('read-runtimes', ['runtimes', '--json']);
    report.after = snapshot(config); report.observed = { version, ext, runtimes }; save();
    const flags = report.assertions = {};
    const check = (name, test) => { try { test(); flags[name] = { passed: true }; } catch (e) { flags[name] = { passed: false, error: e.message }; } save(); };
    check('readOnly', () => assert.equal(hash(JSON.stringify(report.after)), hash(JSON.stringify(report.before)), 'whole config metadata, hashes and link targets must remain unchanged'));
    check('versionPending', () => { ok(version); assert(version.stdout.includes(`cotal-ai ${c}`)); assert.match(version.stdout + version.stderr, /pending/i); assert.match(version.stdout + version.stderr, /cotal update/); });
    check('previousSelection', () => {
      selection(b);
      assert(!existsSync(join(dirname(previous.currentPath), c)), 'reads must not create a C selection directory');
    });
    check('extensionInventory', () => {
      const envelope = JSON.parse(ok(ext).stdout); assert.equal(envelope.command, 'ext'); assert.equal(envelope.result.root, join(previous.selected.root, 'extensions'));
      const items = envelope.result.items; assert.equal(items.length, 8); assert.equal(new Set(items.map(i => i.pkg)).size, 8);
      assert(items.some(i => i.pkg === '@cotal-ai/tmux')); assert(items.every(i => i.version === b));
      const manifest = json(join(envelope.result.root, 'extensions.json')); assert.equal(manifest.extensions.length, 8);
      for (const item of items) { assert(manifest.extensions.some(i => i.pkg === item.pkg && i.version === b)); assert.equal(json(join(envelope.result.root, 'node_modules', item.pkg, 'package.json')).version, b); }
    });
    check('runtimeRefusal', () => {
      assert(!runtimes.error && !runtimes.signal && !runtimes.timedOut); assert.equal(runtimes.code, 4);
      const envelope = JSON.parse(runtimes.stdout), tmux = envelope.result.items.find(i => i.name === 'tmux');
      assert.equal(envelope.command, 'runtimes'); assert.equal(tmux.state, 'installed'); assert.equal(tmux.reachable, null);
      assert(tmux.error.includes(b) && tmux.error.includes(c)); assert.match(tmux.error, /cotal update/);
    });
    if (Object.values(flags).every(f => f.passed) && mode === 'normal') {
      const contents = state => Object.fromEntries(Object.entries(state).map(([path, row]) => [path, Object.fromEntries(Object.entries(row).filter(([key]) => ['mode', 'uid', 'gid', 'sha256', 'link'].includes(key)))]));
      const prior = contents(snapshot(previous.selected.root)), priorSelection = readFileSync(previous.selectionPath, 'utf8');
      ok(await cli('reconcile-C', ['update', '--self']));
      check('isolatedReconciliation', () => {
        const next = selection(c); assert.notEqual(next.selected.root, previous.selected.root);
        assert.deepEqual(contents(snapshot(previous.selected.root)), prior, 'reconciliation must preserve predecessor contents, permissions and link targets');
        assert.equal(readFileSync(previous.selectionPath, 'utf8'), priorSelection, 'predecessor selection must remain unchanged');
      });
      const reconciled = JSON.parse(ok(await cli('read-reconciled-ext', ['ext', '--json'])).stdout);
      check('reconciledInventory', () => {
        assert.equal(reconciled.result.items.length, 8);
        assert(reconciled.result.items.every(item => item.version === c));
        assert.equal(reconciled.result.root, join(selection(c).selected.root, 'extensions'));
      });
    }
    report.passed = Object.values(flags).every(f => f.passed);
  } catch (error) { report.failure = error.stack; }
  finally {
    report.registryCleanup = [];
    for (const overlay of overlays) { try { report.registryCleanup.push({ url: overlay.url, requests: await overlay.close(), closed: true }); } catch (e) { report.passed = false; report.registryCleanup.push({ url: overlay.url, error: e.stack }); } }
    report.quiescent = report.registryCleanup.every(r => r.closed) && report.calls.every(r => r.finishedAt && !r.error);
    save();
  }
  return report;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  automaticUpdateRetainedReads(...process.argv.slice(2)).then(report => { console.log(JSON.stringify(report)); process.exitCode = report.passed ? 0 : 1; }).catch(error => { console.error(error); process.exitCode = 1; });
}
