import { spawn } from 'node:child_process';
import { existsSync, openSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { nodeInstaller, npmOnPath } from './node-install.mjs';
import { must, productEnv, run, shell } from './proc.mjs';

const app = { exe: '/usr/bin/cotal-desktop', node: '/usr/bin/cotal-node', cli: '/usr/lib/Cotal/runtime/dist/cotal.js' };
let display = process.env.DISPLAY;

function manager() {
  for (const name of ['apt-get', 'dnf', 'zypper']) if (existsSync(`/usr/bin/${name}`)) return name;
  throw new Error('this Linux has none of apt-get, dnf or zypper; only .deb and .rpm packages are published');
}

function kind() {
  return manager() === 'apt-get' ? 'deb' : 'rpm';
}

function label() {
  const name = /^PRETTY_NAME="?([^"\n]+)"?$/m.exec(readFileSync('/etc/os-release', 'utf8'))?.[1];
  return name ?? 'Linux';
}

async function install(file) {
  const command = {
    'apt-get': ['env', 'DEBIAN_FRONTEND=noninteractive', 'apt-get', 'install', '-y', '-q', file],
    dnf: ['dnf', 'install', '-y', '-q', file],
    // The published rpm is not signed, as dnf also notes.
    zypper: ['zypper', '--non-interactive', '--quiet', 'install', '--allow-unsigned-rpm', file],
  }[manager()];
  const result = await run('sudo', ['-n', ...command], { timeout: 600_000 });
  return { code: result.code, ms: result.ms, output: result.code === 0 ? undefined : (result.stderr || result.stdout).slice(-1500) };
}

const sockets = () => (existsSync('/tmp/.X11-unix') ? readdirSync('/tmp/.X11-unix') : []);

/**
 * The app needs an X display; a headless machine gets a private Xvfb. Distributions without an X
 * server (Enterprise Linux 10) get a headless Weston, whose Xwayland takes the first free display.
 */
async function ensureDisplay(out) {
  if (display) return display;
  const xvfb = existsSync('/usr/bin/Xvfb');
  const before = new Set(sockets());
  const log = openSync(join(out, xvfb ? 'xvfb.log' : 'weston.log'), 'a');
  const [file, args] = xvfb
    ? ['Xvfb', [':99', '-screen', '0', '1280x800x24', '-nolisten', 'tcp']]
    : ['weston', ['--backend=headless', '--xwayland', '--socket=cotal-scenario', '--width=1280', '--height=800']];
  spawn(file, args, { detached: true, stdio: ['ignore', log, log] }).unref();
  for (let i = 0; i < 50; i++) {
    const candidate = xvfb ? ':99' : sockets().filter((name) => !before.has(name)).map((name) => `:${name.slice(1)}`)[0];
    if (candidate && (await run('xdpyinfo', [], { env: { ...process.env, DISPLAY: candidate }, timeout: 5000 })).code === 0) return (display = candidate);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${file} did not give an X display within 10 s`);
}

async function launch(out) {
  const env = productEnv({ DISPLAY: await ensureDisplay(out) });
  const log = openSync(join(out, `app-${Date.now()}.log`), 'a');
  const child = spawn(app.exe, [], { env, detached: true, stdio: ['ignore', log, log] });
  child.unref();
  return child.pid;
}

/** A mapped top-level window titled "Cotal". Enterprise Linux 10 has xdotool instead of xwininfo. */
async function window() {
  if (!existsSync('/usr/bin/xwininfo')) {
    const found = await run('xdotool', ['search', '--onlyvisible', '--name', '^Cotal$'], { env: { ...process.env, DISPLAY: display }, timeout: 10_000 });
    const id = found.stdout.trim().split('\n')[0];
    return { ok: found.code === 0 && /^\d+$/.test(id), id };
  }
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
