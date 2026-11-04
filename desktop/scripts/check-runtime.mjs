import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const root = fileURLToPath(new URL('../src-tauri/', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'cd-check-'));
const staged = join(root, 'runtime'), relocated = join(scratch, 'runtime');
const manifest = JSON.parse(readFileSync(join(staged, 'desktop-runtime.json'), 'utf8'));
assert.match(manifest.target, /^[a-z0-9_-]+$/);
const node = join(root, 'binaries', `cotal-node-${manifest.target}${process.platform === 'win32' ? '.exe' : ''}`);
const home = join(scratch, 'home'); mkdirSync(home, { mode: 0o700 });
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('COTAL_') && !['NODE_OPTIONS', 'NODE_PATH'].includes(key)));
Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: join(home, 'appdata'), LOCALAPPDATA: join(home, 'localappdata'), XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'), XDG_CACHE_HOME: join(home, 'cache'), XDG_RUNTIME_DIR: join(home, 'run'), DO_NOT_TRACK: '1' });
mkdirSync(env.XDG_RUNTIME_DIR, { mode: 0o700 });
cpSync(staged, relocated, { recursive: true, verbatimSymlinks: true });
try {
  const cli = join(relocated, 'dist/cotal.js');
  const run = (args, input) => spawnSync(node, [cli, ...args], { cwd: scratch, env, input, encoding: 'utf8', timeout: 30000 });
  const version = run(['--version']); assert.equal(version.status, 0); assert.equal(version.stdout.trim(), `cotal-ai ${manifest.version}`);
  console.log('PASS relocated stock CLI reports its pinned version');
  const about = run(['daemon', 'desktop'], '{"op":"about"}\n');
  if (about.status !== 0) {
    const report = (check, result) => console.error(JSON.stringify({
      check, status: result.status, signal: result.signal, error: result.error?.message,
      stdout: (result.stdout ?? '').slice(-4000), stderr: (result.stderr ?? '').slice(-4000),
    }));
    const probe = (check, executable, args, input) => report(check, spawnSync(executable, args, {
      cwd: scratch, env, input, encoding: 'utf8', timeout: 30000,
    }));
    report('desktop-about', about);
    const input = '{"op":"about"}\n';
    probe('copied-node-stdin-os', node, ['--input-type=module', '-e',
      "import { hostname, platform, arch, release, totalmem } from 'node:os'; let text = ''; for await (const chunk of process.stdin) { text += chunk; if (text.includes('\\n')) break; } JSON.parse(text); hostname(); platform(); arch(); release(); totalmem(); console.log('stdin-os-ok');"], input);
    probe('stock-node-about', process.execPath, [cli, 'daemon', 'desktop'], input);
    const branded = join(scratch, 'cotal-node.exe'), canonical = join(scratch, 'node.exe');
    cpSync(node, branded); cpSync(node, canonical);
    assert.equal(createHash('sha256').update(readFileSync(branded)).digest('hex'), createHash('sha256').update(readFileSync(canonical)).digest('hex'));
    probe('same-directory-branded-about', branded, [cli, 'daemon', 'desktop'], input);
    probe('same-directory-canonical-about', canonical, [cli, 'daemon', 'desktop'], input);
  }
  assert.equal(about.status, 0); assert.equal(JSON.parse(about.stdout).result.version, manifest.version);
  console.log('PASS relocated desktop bridge runs with bundled Node');
  const status = run(['daemon', 'desktop'], '{"op":"status"}\n'); assert.equal(status.status, 0); assert.equal(JSON.parse(status.stdout).ok, false);
  assert.equal(existsSync(join(env.XDG_RUNTIME_DIR, 'cotal/daemon.sock')), false);
  console.log('PASS missing daemon remains unavailable; no service started');
  const update = run(['update', '--self']); assert.notEqual(update.status, 0); assert.match(update.stdout + update.stderr, /runtime belongs to the desktop app/);
  console.log('PASS bundled runtime refuses npm self-update');
  for (const file of manifest.files) assert.equal(createHash('sha256').update(readFileSync(join(relocated, file.path))).digest('hex'), file.sha256, file.path);
  console.log(`PASS ${manifest.files.length} packaged file hashes unchanged after checks`);
} finally { rmSync(scratch, { recursive: true, force: true }); }
