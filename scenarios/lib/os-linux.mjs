import { spawn } from 'node:child_process';
import { existsSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { nodeInstaller, npmOnPath } from './node-install.mjs';
import { must, productEnv, run, shell } from './proc.mjs';

const app = { exe: '/usr/bin/cotal-desktop', node: '/usr/bin/cotal-node', cli: '/usr/lib/Cotal/runtime/dist/cotal.js' };
let display = process.env.DISPLAY;

function kind() {
  if (existsSync('/usr/bin/apt-get')) return 'deb';
  if (existsSync('/usr/bin/dnf')) return 'rpm';
  throw new Error('this Linux has neither apt-get nor dnf; only Ubuntu/Debian and Fedora packages are published');
}

function label() {
  const name = /^PRETTY_NAME="?([^"\n]+)"?$/m.exec(readFileSync('/etc/os-release', 'utf8'))?.[1];
  return name ?? 'Linux';
}

async function install(file) {
  const result = kind() === 'deb'
    ? await run('sudo', ['-n', 'env', 'DEBIAN_FRONTEND=noninteractive', 'apt-get', 'install', '-y', '-q', file], { timeout: 600_000 })
    : await run('sudo', ['-n', 'dnf', 'install', '-y', '-q', file], { timeout: 600_000 });
  return { code: result.code, ms: result.ms, output: result.code === 0 ? undefined : (result.stderr || result.stdout).slice(-1500) };
}

/** The app needs an X display; a headless machine gets a private Xvfb. */
async function ensureDisplay(out) {
  if (display) return display;
  const log = openSync(join(out, 'xvfb.log'), 'a');
  const child = spawn('Xvfb', [':99', '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], { detached: true, stdio: ['ignore', log, log] });
  child.unref();
  display = ':99';
  for (let i = 0; i < 50; i++) {
    if ((await run('xwininfo', ['-root'], { env: { ...process.env, DISPLAY: display }, timeout: 5000 })).code === 0) return display;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Xvfb did not start on :99');
}

async function launch(out) {
  const env = productEnv({ DISPLAY: await ensureDisplay(out) });
  const log = openSync(join(out, `app-${Date.now()}.log`), 'a');
  const child = spawn(app.exe, [], { env, detached: true, stdio: ['ignore', log, log] });
  child.unref();
  return child.pid;
}

/** A mapped top-level window titled "Cotal". */
async function window() {
  const tree = await run('xwininfo', ['-root', '-tree'], { env: { ...process.env, DISPLAY: display }, timeout: 10_000 });
  const id = /^\s+(0x[0-9a-f]+) "Cotal":/m.exec(tree.stdout)?.[1];
  if (!id) return { ok: false };
  const info = await run('xwininfo', ['-id', id], { env: { ...process.env, DISPLAY: display }, timeout: 10_000 });
  return { ok: /Map State: IsViewable/.test(info.stdout), id };
}

async function quit(pid) {
  await run('kill', ['-TERM', String(pid)]);
}

/** Nothing of a previous Cotal on this machine. */
function leftovers(home) {
  return [app.exe, app.node, '/usr/lib/Cotal', join(home, '.cotal'), join(home, '.config', 'cotal'), join(home, '.local', 'share', 'cotal')].filter((path) => existsSync(path));
}

async function setHosts(block) {
  const current = readFileSync('/etc/hosts', 'utf8');
  await must('sudo', ['-n', 'tee', '/etc/hosts'], { input: block(current) });
}

async function npmGlobal(spec) {
  const prefix = (await shell('npm prefix -g')).stdout.trim();
  const writable = (await run('test', ['-w', join(prefix, 'lib')])).code === 0;
  return writable ? run('npm', ['install', '-g', spec], { timeout: 600_000 }) : run('sudo', ['-n', 'env', `PATH=${process.env.PATH}`, 'npm', 'install', '-g', spec], { timeout: 600_000 });
}

async function ensureNpm(directory) {
  const present = await npmOnPath();
  if (present) return { npm: present };
  const file = await nodeInstaller(/^node-v24\.\d+\.\d+-linux-x64\.tar\.xz$/, directory);
  await must('sudo', ['-n', 'tar', '-xJf', file, '-C', '/usr/local', '--strip-components=1', '--exclude=CHANGELOG.md', '--exclude=LICENSE', '--exclude=README.md'], { timeout: 300_000 });
  return { installed: file.split('/').pop(), npm: await npmOnPath() };
}

export default { app, kind, label, install, launch, window, quit, leftovers, setHosts, npmGlobal, ensureNpm };
