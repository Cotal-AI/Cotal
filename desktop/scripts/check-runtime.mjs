import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, readFileSync, readdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
  const status = run(['daemon', 'desktop'], '{"op":"status"}\n'); assert.equal(status.status, 0); assert.equal(JSON.parse(status.stdout).ok, false);
  assert.equal(existsSync(join(env.XDG_RUNTIME_DIR, 'cotal/daemon.sock')), false);
  console.log('PASS missing daemon remains unavailable; no service started');
  const daemonStatus = run(['daemon', 'status']); assert.notEqual(daemonStatus.status, 0); assert.match(daemonStatus.stdout + daemonStatus.stderr, /no daemon endpoint/);
  console.log('PASS relocated CLI daemon status reports missing endpoint cleanly');
  const update = run(['update', '--self']); assert.notEqual(update.status, 0); assert.match(update.stdout + update.stderr, /runtime belongs to the desktop app/);
  console.log('PASS bundled runtime refuses npm self-update');

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
