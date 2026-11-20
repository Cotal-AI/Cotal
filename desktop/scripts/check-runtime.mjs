import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, readFileSync, readdirSync, realpathSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { setTimeout as pause } from 'node:timers/promises';

async function checkMacQuarantine(source) {
  assert.equal(process.platform, 'darwin');
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'cd-quarantine-')));
  const home = join(scratch, 'home');
  const daemonHome = join(scratch, 'daemon-home');
  const app = join(scratch, 'Cotal.app');
  const runtime = join(app, 'Contents/Resources/runtime');
  const node = join(app, 'Contents/MacOS/cotal-node');
  const cli = join(runtime, 'dist/cotal.js');
  const space = 'gatekeeper-proof';
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('COTAL_') && !['NODE_OPTIONS', 'NODE_PATH'].includes(key)));
  Object.assign(env, { HOME: home, COTAL_HOME: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'), XDG_CACHE_HOME: join(home, 'cache'), DO_NOT_TRACK: '1', COTAL_NO_UPDATE_CHECK: '1', COTAL_SKIP_CONNECTOR_SEED: '1' });
  const probe = (command, args, timeout = 10_000) => {
    const r = spawnSync(command, args, { cwd: runtime, env, encoding: 'utf8', timeout, killSignal: 'SIGKILL' });
    return { status: r.status, signal: r.signal, stdout: r.stdout?.trim(), stderr: r.stderr?.trim(), error: r.error?.message };
  };
  const inspect = (label, executable, addons) => {
    for (const file of [executable, ...addons]) {
      console.log(JSON.stringify({ label, file, xattr: probe('/usr/bin/xattr', ['-l', file]),
        spctl: probe('/usr/sbin/spctl', ['--assess', '-vv', file]), codesign: probe('/usr/bin/codesign', ['-dv', file]) }));
    }
  };
  const load = (label, executable, addons) => {
    console.log(JSON.stringify({ label, file: executable, run: probe(executable, ['--version']) }));
    for (const file of addons) {
      const args = ['-e', 'require(process.argv[1])', file];
      console.log(JSON.stringify({ label, file, dlopen: probe(executable, args), dlopenFromRunnerNode: probe(process.execPath, args) }));
    }
  };
  const startManager = (socket) => new Promise((resolve, reject) => {
    const client = connect(socket);
    let text = '';
    client.setTimeout(105_000, () => client.destroy(new Error('manager-start timed out')));
    client.once('error', reject);
    client.once('end', () => reject(new Error('daemon ended before replying')));
    client.once('connect', () => client.write(`${JSON.stringify({ v: 1, id: 'quarantine-proof', op: 'manager-start', space })}\n`));
    client.on('data', (chunk) => {
      text += chunk;
      if (text.includes('\n')) {
        client.destroy();
        try { resolve(JSON.parse(text.split('\n')[0])); } catch (error) { reject(error); }
      }
    });
  });
  let daemon, ended;
  try {
    cpSync(source, app, { recursive: true, verbatimSymlinks: true });
    mkdirSync(home, { mode: 0o700 });
    mkdirSync(join(daemonHome, 'daemon'), { recursive: true, mode: 0o700 });
    const manifest = JSON.parse(readFileSync(join(runtime, 'desktop-runtime.json'), 'utf8'));
    const addonPaths = manifest.files.filter(({ path }) => path.endsWith('.node')).map(({ path }) => path);
    for (const name of ['pty.node', 'process.node']) assert.ok(addonPaths.some(path => path.endsWith(`/${name}`)), `missing ${name}`);
    const fixture = probe(node, ['--input-type=module', '-e', `
      import { mkdirSync, writeFileSync } from 'node:fs';
      import { dirname, join } from 'node:path';
      import { globalConfigDir } from '@cotal-ai/core';
      import { recordMesh, spaceSegment } from '@cotal-ai/workspace';
      import { saveIdpSession } from '@cotal-ai/auth';
      const [space, version, daemonHome] = process.argv.slice(1);
      const home = process.env.COTAL_HOME;
      const idp = 'http://127.0.0.1:1';
      const stamp = join(globalConfigDir(), 'seed/stamp.json');
      mkdirSync(dirname(stamp), { recursive: true, mode: 0o700 });
      writeFileSync(stamp, JSON.stringify({ generation: version }), { mode: 0o600 });
      recordMesh({ space, server: 'nats://127.0.0.1:1', root: home, mode: 'user', origin: 'manual', ts: new Date().toISOString(),
        userAuth: { provider: 'cotal', remote: true, idp: { url: idp, issuer: idp, audience: idp }, endpoints: { url: idp } } });
      saveIdpSession(daemonHome, idp, { token: 'fixture-session', sub: 'fixture', expiresAt: Math.floor(Date.now() / 1000) + 3600 });
      console.log(join(daemonHome, 'daemon', spaceSegment(space), 'manager', 'manager.log'));
    `, space, manifest.version, daemonHome]);
    assert.equal(fixture.status, 0, JSON.stringify(fixture));

    // Run the already-approved app's daemon first, then model its files still carrying download marks.
    // Only the disposable app copy is marked. No Gatekeeper settings or signing are changed.
    daemon = spawn(node, [cli, 'daemon', 'serve', '--daemon-home', daemonHome], { cwd: scratch, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    daemon.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    daemon.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    ended = new Promise(resolve => {
      daemon.once('error', error => resolve({ error: error.message }));
      daemon.once('close', (status, signal) => resolve({ status, signal }));
    });
    let socket;
    for (let i = 0; i < 600 && !socket && daemon.exitCode === null && daemon.signalCode === null; i++) {
      socket = /^daemon ready at (.+)$/m.exec(stdout)?.[1];
      if (!socket) await pause(50);
    }
    assert.ok(socket, `daemon did not become ready: ${stdout}${stderr}`);
    console.log(JSON.stringify({ macOS: probe('/usr/bin/sw_vers', []), architecture: process.arch, gatekeeper: probe('/usr/sbin/spctl', ['--status']) }));
    const quarantine = `0081;${Math.floor(Date.now() / 1000).toString(16)};Safari;${randomUUID().toUpperCase()}`;
    const mark = probe('/usr/bin/xattr', ['-rw', 'com.apple.quarantine', quarantine, app], 60_000);
    assert.equal(mark.status, 0, JSON.stringify(mark));

    const manager = await startManager(socket);
    const managerLog = existsSync(fixture.stdout) ? readFileSync(fixture.stdout, 'utf8').slice(-16_384) : undefined;
    console.log(JSON.stringify({ manager, managerLog, stderr }));
    daemon.kill('SIGTERM');
    const force = setTimeout(() => daemon.kill('SIGKILL'), 10_000);
    try { console.log(JSON.stringify({ daemonExit: await ended })); } finally { clearTimeout(force); }

    const appAddons = addonPaths.map(path => join(runtime, path));
    inspect('app bundle', app, []);
    inspect('app', node, appAddons);
    const store = join(daemonHome, 'daemon/app-manager-runtimes');
    const copies = existsSync(store) ? readdirSync(store).filter(name => /^[a-f0-9]{64}$/.test(name)) : [];
    assert.equal(copies.length, 1, 'expected the daemon to publish a retained runtime');
    const retained = join(store, copies[0]);
    const retainedNode = join(retained, 'cotal-node');
    const retainedAddons = addonPaths.map(path => join(retained, 'runtime', path));
    inspect('retained', retainedNode, retainedAddons);
    load('app', node, appAddons);
    load('retained', retainedNode, retainedAddons);
  } finally {
    if (daemon && daemon.exitCode === null && daemon.signalCode === null) daemon.kill('SIGKILL');
    await ended;
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[2] === '--mac-quarantine-app') {
  await checkMacQuarantine(process.argv[3]);
  process.exit(0);
}

const root = fileURLToPath(new URL('../src-tauri/', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'cd-check-'));
const staged = join(root, 'runtime'), relocated = join(scratch, 'runtime');
const manifest = JSON.parse(readFileSync(join(staged, 'desktop-runtime.json'), 'utf8'));
assert.match(manifest.target, /^[a-z0-9_-]+$/);
const sidecar = process.platform === 'win32' ? 'node' : 'cotal-node';
const suffix = process.platform === 'win32' ? '.exe' : '';
const stagedNode = join(root, 'binaries', `${sidecar}-${manifest.target}${suffix}`);
const node = join(scratch, `${sidecar}${suffix}`);
const home = join(scratch, 'home'); mkdirSync(home, { mode: 0o700 });
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('COTAL_') && !['NODE_OPTIONS', 'NODE_PATH'].includes(key)));
Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: join(home, 'appdata'), LOCALAPPDATA: join(home, 'localappdata'), XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'), XDG_CACHE_HOME: join(home, 'cache'), XDG_RUNTIME_DIR: join(home, 'run'), DO_NOT_TRACK: '1', COTAL_NO_UPDATE_CHECK: '1', COTAL_SKIP_CONNECTOR_SEED: '1' });
mkdirSync(env.XDG_RUNTIME_DIR, { mode: 0o700 });
cpSync(staged, relocated, { recursive: true, verbatimSymlinks: true });
// Exercise the installed basename, after Tauri removes the target suffix.
cpSync(stagedNode, node, { errorOnExist: true, force: false });
try {
  const cli = join(relocated, 'dist/cotal.js');
  const run = (args, input, customEnv = env) => spawnSync(node, [cli, ...args], { cwd: scratch, env: customEnv, input, encoding: 'utf8', timeout: 30000 });
  const version = run(['--version']); assert.equal(version.status, 0); assert.equal(version.stdout.trim(), `cotal-ai ${manifest.version}`);
  console.log('PASS relocated stock CLI reports its pinned version');
  const about = run(['daemon', 'desktop'], '{"op":"about"}\n'); assert.equal(about.status, 0); assert.equal(JSON.parse(about.stdout).result.version, manifest.version);
  console.log('PASS relocated desktop bridge runs with bundled Node');
  if (process.platform === 'win32') {
    // The app passes Tauri's resource path, which carries the extended-length prefix.
    const extended = spawnSync(node, [`\\\\?\\${realpathSync.native(cli)}`, 'daemon', 'desktop'], { cwd: scratch, env, input: '{"op":"about"}\n', encoding: 'utf8', timeout: 30000 });
    assert.equal(extended.status, 0); assert.equal(JSON.parse(extended.stdout).result.version, manifest.version);
    console.log('PASS desktop bridge runs through an extended-length runtime path');
  }
  const status = run(['daemon', 'desktop'], '{"op":"status"}\n'); assert.equal(status.status, 0); assert.equal(JSON.parse(status.stdout).ok, false);
  assert.equal(existsSync(join(env.XDG_RUNTIME_DIR, 'cotal/daemon.sock')), false);
  console.log('PASS missing daemon remains unavailable; no service started');
  const daemonStatus = run(['daemon', 'status']); assert.notEqual(daemonStatus.status, 0); assert.match(daemonStatus.stdout + daemonStatus.stderr, /Native code:\s+NOT_RUNNING/);
  console.log('PASS relocated CLI daemon status reports missing endpoint cleanly');
  const update = run(['update', '--self']); assert.notEqual(update.status, 0); assert.match(update.stdout + update.stderr, /runtime belongs to the desktop app/);
  console.log('PASS bundled runtime refuses npm self-update');

  const lazyRuntimeFiles = [
    'package.json',
    'desktop-runtime.json',
    'dist/cotal.js',
    'dist/daemon-cwd.js',
    'dist/daemon-native.js',
    'seeded-connectors/_shared/docs-bundle.bin',
    'seeded-connectors/_shared/docs-index.bin',
    'seeded-connectors/claude/.claude-plugin/plugin.json',
    'seeded-connectors/claude/.mcp.json',
    'seeded-connectors/claude/hooks/hooks.json',
    'seeded-connectors/claude/dist/mcp.cjs',
    'seeded-connectors/claude/dist/seat.cjs',
    'seeded-connectors/claude/dist/hook.cjs',
    'seeded-connectors/claude/dist/monitor.cjs',
    'seeded-connectors/codex/dist/host.js',
    'seeded-connectors/codex/dist/personal.js',
    'seeded-connectors/hermes/dist/launch.js',
    'seeded-connectors/hermes/plugin/cotal/_sidecar/standalone.cjs',
    'seeded-connectors/jcode/dist/host.js',
    'seeded-connectors/jcode/dist/mcp.js',
    'seeded-connectors/opencode/dist/plugin/index.js',
    'seeded-connectors/opencode/dist/serve.js',
    'seeded-connectors/opencode/dist/launch.js',
    'seeded-connectors/pi/dist/standalone.js',
    'seeded-connectors/web/dist/web/index.html',
    'seeded-connectors/web/dist/web/theme-boot.js',
    'seeded-connectors/web/dist/web/bundle-licenses.json',
    'seeded-connectors/claude/skills-plugin/.claude-plugin/plugin.json',
    'node_modules/@cotal-ai/cli/cotal-skills/skills/team-topology/SKILL.md',
    'node_modules/@cotal-ai/connector-core/dist/docs-bundle.bin',
    'node_modules/@cotal-ai/connector-core/dist/docs-index.bin',
    'node_modules/@cotal-ai/lang/conformance/corpus.json',
    'node_modules/@cotal-ai/lang/dist/engine/worker-entry.js',
    'node_modules/@cotal-ai/manager/dist/console/index.html',
    'node_modules/@cotal-ai/manager/dist/console/app.js',
    'node_modules/@cotal-ai/manager/dist/console/session-bundle.js',
    'node_modules/@cotal-ai/seat/dist/custodian.js',
    'node_modules/@cotal-ai/workspace/dist/win32-custodian.js',
    'node_modules/@xterm/xterm/lib/xterm.js',
    'node_modules/@xterm/xterm/css/xterm.css',
    'node_modules/@xterm/addon-fit/lib/addon-fit.js',
    'node_modules/@xterm/addon-attach/lib/addon-attach.js',
  ];
  for (const rel of lazyRuntimeFiles) {
    assert.equal(existsSync(join(relocated, rel)), true, `missing lazily read runtime file: ${rel}`);
  }
  const docsSpec = run(['docs', 'spec']); assert.equal(docsSpec.status, 0, `cotal docs spec failed: ${docsSpec.stderr}`); assert.ok(docsSpec.stdout.length > 1000);
  const docsSchema = run(['docs', 'schema']); assert.equal(docsSchema.status, 0, `cotal docs schema failed: ${docsSchema.stderr}`); assert.ok(docsSchema.stdout.includes('"$schema"'));
  const docsLang = run(['docs', 'lang']); assert.equal(docsLang.status, 0, `cotal docs lang failed: ${docsLang.stderr}`); assert.ok(docsLang.stdout.length > 1000);
  const corpusCheck = spawnSync(
    node,
    ['--input-type=module', '-e', 'import { conformanceCorpus } from "@cotal-ai/lang"; const c = conformanceCorpus(); if (!c.cases.length) throw new Error("empty corpus");'],
    { cwd: relocated, env, encoding: 'utf8', timeout: 30000 },
  );
  assert.equal(corpusCheck.status, 0, `conformanceCorpus() failed: ${corpusCheck.stderr || corpusCheck.stdout}`);
  console.log(`PASS ${lazyRuntimeFiles.length} lazily read runtime files exist and docs/conformance readers succeed`);

  const noBrokerBin = join(scratch, 'empty-bin'); mkdirSync(noBrokerBin, { mode: 0o700 });
  const projDir = join(scratch, 'local-proj'); mkdirSync(projDir, { mode: 0o700 });
  const manifestYaml = join(projDir, 'cotal.yaml');
  writeFileSync(manifestYaml, 'apiVersion: cotal/v1\nkind: Mesh\nspace: localcheck\nchannels:\n  main: {}\n', { mode: 0o600 });
  const noBrokerEnv = { ...env, PATH: noBrokerBin };
  const localUp = run(['up', '-f', manifestYaml], undefined, noBrokerEnv);
  assert.notEqual(localUp.status, 0);
  assert.match(localUp.stdout + localUp.stderr, /nats-server not found on PATH/);
  console.log('PASS local-broker command fails with clear nats-server not found refusal');

  const addons = manifest.files.filter((file) => file.path.endsWith('.node')).map((file) => join(relocated, file.path));
  assert.ok(addons.length >= 2, `expected at least 2 native .node addons, found ${addons.length}`);
  for (const addon of addons) {
    const loadAddon = spawnSync(node, ['-e', 'require(require("node:path").resolve(process.argv[1]))', addon], { cwd: relocated, env, encoding: 'utf8', timeout: 30000 });
    assert.equal(loadAddon.status, 0, `failed to load native addon ${addon}: ${loadAddon.stderr || loadAddon.stdout}`);
  }
  console.log(`PASS ${addons.length} native .node addons load under bundled Node`);

  const cotalScope = join(relocated, 'node_modules', '@cotal-ai');
  const specs = [];
  for (const pkg of readdirSync(cotalScope).sort()) {
    const pkgJson = JSON.parse(readFileSync(join(cotalScope, pkg, 'package.json'), 'utf8'));
    specs.push(`@cotal-ai/${pkg}`);
    if (pkgJson.exports && typeof pkgJson.exports === 'object') {
      for (const key of Object.keys(pkgJson.exports)) {
        if (key === '.' || key === './package.json' || key === './engine/worker-entry' || key.includes('*')) continue;
        specs.push(`@cotal-ai/${pkg}/${key.slice(2)}`);
      }
    }
  }
  const importAll = spawnSync(
    node,
    ['--input-type=module', '-e', 'for (const s of JSON.parse(process.argv[1])) await import(s);', JSON.stringify(specs)],
    { cwd: relocated, env, encoding: 'utf8', timeout: 30000 },
  );
  assert.equal(importAll.status, 0, `failed to import @cotal-ai/* entries: ${importAll.stderr || importAll.stdout}`);
  console.log(`PASS ${specs.length} @cotal-ai/* package entries imported under bundled Node`);

  const listCommands = spawnSync(
    node,
    [
      '--input-type=module',
      '-e',
      [
        'import { registry } from "@cotal-ai/core";',
        'await import("@cotal-ai/cli");',
        'await import("@cotal-ai/manager");',
        'await import("@cotal-ai/delivery");',
        'await import("@cotal-ai/runtime");',
        'await import("@cotal-ai/auth");',
        `await import(${JSON.stringify(pathToFileURL(join(relocated, 'dist/docs.js')).href)});`,
        `await import(${JSON.stringify(pathToFileURL(join(relocated, 'dist/daemon/command.js')).href)});`,
        `await import(${JSON.stringify(pathToFileURL(join(relocated, 'dist/daemon/update-entry.js')).href)});`,
        'console.log(JSON.stringify(registry.all("command").map(c => c.name).filter(n => !n.startsWith("__")).sort()));',
      ].join('\n'),
    ],
    { cwd: relocated, env, encoding: 'utf8', timeout: 30000 },
  );
  assert.equal(listCommands.status, 0, `failed to enumerate CLI commands: ${listCommands.stderr || listCommands.stdout}`);
  const commands = JSON.parse(listCommands.stdout.trim());
  assert.ok(commands.length >= 60, `expected at least 60 CLI commands, found ${commands.length}`);
  for (const cmd of commands) {
    const help = run([cmd, '--help']);
    assert.equal(help.status, 0, `${cmd} --help failed: ${help.stderr || help.stdout}`);
    assert.ok(help.stdout.trim().length > 0, `${cmd} --help produced empty stdout`);
  }
  console.log(`PASS all ${commands.length} CLI commands answered --help under bundled Node`);

  for (const file of manifest.files) {
    assert.equal(createHash('sha256').update(readFileSync(join(relocated, file.path))).digest('hex'), file.sha256, file.path);
    if (file.path.startsWith('node_modules/')) {
      assert.doesNotMatch(file.path, /\.(?:map|d\.[cm]?ts|pdb|tsbuildinfo)$/, `unexpected build artifact in runtime: ${file.path}`);
      assert.doesNotMatch(file.path, /^node_modules\/@eplightning\/nats-server-/, `unexpected bundled nats-server in desktop runtime: ${file.path}`);
    }
  }
  console.log(`PASS ${manifest.files.length} packaged file hashes unchanged after checks`);
} finally { rmSync(scratch, { recursive: true, force: true }); }
