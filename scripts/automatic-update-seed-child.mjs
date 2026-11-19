/** Real packed-closure regression for the first plain up after another home's self-update. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { isMainEntry } from './main-entry.mjs';
import { candidateRegistry } from './automatic-update-platform-baseline.mjs';
import { compareVersions } from './upgrade-matrix-plan.mjs';

export async function automaticUpdateSeedChild(sourcePack, targetPack, privateRoot) {
  assert(sourcePack && targetPack && privateRoot, 'usage: <source-normal-pack> <target-normal-pack> <new-private-root>');
  const root = resolve(privateRoot), currentNode = process.execPath;
  assert(!existsSync(root), 'private root must be fresh');
  mkdirSync(root, { mode: 0o700 });
  const prefix = join(root, 'prefix'), entry = join(prefix, 'bin/cotal'), calls = [], envs = {};
  const report = { root, currentNode, calls }, hash = value => createHash('sha256').update(value).digest('hex');
  const json = file => JSON.parse(readFileSync(file, 'utf8'));
  const save = () => writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  let source, target, running = false;
  for (const home of ['A', 'B']) {
    const base = join(root, home);
    for (const dir of ['', 'config', 'cotal', 'runtime', 'tmp', 'project']) mkdirSync(join(base, dir), { recursive: true, mode: 0o700 });
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(COTAL_|NODE_OPTIONS$|NODE_PATH$|npm_config_before$|npm_before$)/i.test(key)));
    envs[home] = { ...env, PATH: [dirname(currentNode), join(prefix, 'bin'), env.PATH].filter(Boolean).join(delimiter), HOME: base,
      COTAL_HOME: join(base, 'cotal'), XDG_CONFIG_HOME: join(base, 'config'), XDG_RUNTIME_DIR: join(base, 'runtime'), TMPDIR: join(base, 'tmp'),
      npm_config_prefix: prefix, npm_config_cache: join(base, 'npm-cache'), npm_config_userconfig: join(base, '.npmrc'), npm_config_globalconfig: join(root, 'npmrc'),
      npm_config_audit: 'false', npm_config_fund: 'false', DO_NOT_TRACK: '1', COTAL_TELEMETRY: 'off', NO_COLOR: '1' };
  }
  async function call(home, label, file, args) {
    console.log('JCODE_PROGRESS ' + JSON.stringify({ message: label }));
    const record = { home, label, file, args, cwd: join(root, home, 'project'), registry: envs[home].npm_config_registry, startedAt: new Date().toISOString(), stdout: '', stderr: '' };
    calls.push(record); save();
    await new Promise(done => {
      const child = spawn(file, args, { cwd: record.cwd, env: envs[home], stdio: ['ignore', 'pipe', 'pipe'] });
      const timer = setTimeout(() => { record.timedOut = true; child.kill('SIGKILL'); }, 240000);
      child.stdout.on('data', bytes => { record.stdout += bytes; }); child.stderr.on('data', bytes => { record.stderr += bytes; });
      child.once('error', error => { record.error = error.message; clearTimeout(timer); done(); });
      child.once('close', (code, signal) => { Object.assign(record, { code, signal }); clearTimeout(timer); done(); });
    });
    record.finishedAt = new Date().toISOString(); save(); return record;
  }
  const cli = (home, label, args) => call(home, label, currentNode, [entry, ...args]);
  const ok = result => { assert.equal(result.code, 0, JSON.stringify(result)); assert(!result.signal && !result.timedOut); return result; };
  try {
    source = await candidateRegistry(resolve(sourcePack), 'A', 'https://registry.npmjs.org/'); report.source = source.identity; save();
    target = await candidateRegistry(resolve(targetPack), 'B', 'https://registry.npmjs.org/'); report.target = target.identity; save();
    assert.match(source.identity.source, /^[a-f0-9]{40}$/); assert.equal(source.identity.source, target.identity.source, 'packs must share one source closure');
    assert(compareVersions(target.identity.version, source.identity.version) > 0, 'target must be newer');
    for (const env of Object.values(envs)) env.npm_config_registry = source.url;
    ok(await call('A', 'install-source', process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '-g', `cotal-ai@${source.identity.version}`]));
    for (const home of ['A', 'B']) ok(await cli(home, `seed-${home}`, ['ext', 'seed']));
    const logicalEntry = realpathSync(entry), logicalKey = hash(logicalEntry), installs = join(root, 'B/config/cotal/installs');
    Object.assign(report, { logicalEntry, logicalKey });
    const oldPath = join(installs, logicalKey, 'sets', source.identity.version, 'selection.json'), oldSelection = json(oldPath);
    report.sourceSelection = { path: oldPath, ...oldSelection, claudeVersion: json(join(oldSelection.root, 'extensions/node_modules/@cotal-ai/connector-claude-code/package.json')).version };
    assert.equal(report.sourceSelection.claudeVersion, source.identity.version); save();
    ok(await cli('B', 'create', ['space', 'create', 'seedchild', '--plain']));
    const port = createServer(); await new Promise((done, reject) => { port.once('error', reject); port.listen(0, '127.0.0.1', done); });
    const server = `nats://127.0.0.1:${port.address().port}`; await new Promise(done => port.close(done));
    running = true; ok(await cli('B', 'up-source', ['up', '--server', server, '--detach']));
    ok(await cli('B', 'down-source', ['down', '--yes'])); running = false;
    for (const env of Object.values(envs)) env.npm_config_registry = target.url;
    ok(await cli('A', 'self-update', ['update', '--self']));
    const installed = realpathSync(join(prefix, 'lib/node_modules/cotal-ai')), store = join(prefix, 'lib/.cotal-generations');
    report.descriptorPath = join(store, `.active-${hash(installed)}.json`); report.executionDescriptor = json(report.descriptorPath);
    assert.equal(json(join(installed, 'package.json')).version, source.identity.version, 'original bootstrap must be retained');
    assert.equal(report.executionDescriptor.generation.version, target.identity.version);
    assert.equal(realpathSync(entry), logicalEntry, 'self-update must retain the original launch route');
    const loadedEntry = join(store, report.executionDescriptor.generation.id, 'cotal-ai/dist/cotal.js');
    report.loadedEntry = loadedEntry; report.loadedKey = hash(loadedEntry); assert.notEqual(report.loadedKey, logicalKey); save();
    running = true; const up = await cli('B', 'first-plain-up', ['up', '--detach']);
    report.selections = readdirSync(installs).flatMap(key => {
      const path = join(installs, key, 'sets', target.identity.version, 'selection.json');
      if (!existsSync(path)) return [];
      const selection = json(path), pkg = join(selection.root, 'extensions/node_modules/@cotal-ai/connector-claude-code/package.json');
      return [{ key, path, ...selection, claudeVersion: existsSync(pkg) ? json(pkg).version : null }];
    }); save();
    ok(up); assert.equal(report.selections.length, 1); assert.equal(report.selections[0].key, logicalKey);
    assert(!existsSync(join(installs, report.loadedKey, 'sets', target.identity.version)), 'loaded entry must not own a target selection');
    assert.equal(report.selections[0].claudeVersion, target.identity.version);
    const version = ok(await cli('B', 'version-target', ['--version'])).stdout.trim().split(/\r?\n/);
    assert.equal(version[0], `cotal-ai ${target.identity.version}`);
    const extensions = version.slice(1).filter(line => /^\s+\S.*\s+\d+\.\d+\.\d+(?:-[\w.-]+)?\s*$/.test(line));
    assert.equal(extensions.length, 7, 'all seven seeded extensions must be reported');
    assert(extensions.every(line => line.trim().split(/\s+/).at(-1) === target.identity.version)); report.passed = true;
  } catch (error) { report.failure = error.stack; throw error; }
  finally {
    try { if (running) ok(await cli('B', 'cleanup', ['down', '--yes'])); }
    catch (error) { report.cleanupFailure = error.stack; throw error; }
    finally { save(); try { if (source) report.sourceRequests = await source.close(); } finally { try { if (target) report.targetRequests = await target.close(); } finally { save(); } } }
  }
  return report;
}
if (isMainEntry(import.meta.url)) {
  automaticUpdateSeedChild(...process.argv.slice(2)).catch(error => { console.error(error); process.exitCode = 1; });
}
