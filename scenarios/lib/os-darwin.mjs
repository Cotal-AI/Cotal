import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeInstaller, npmOnPath } from './node-install.mjs';
import { must, run, sleep } from './proc.mjs';

const bundle = '/Applications/Cotal.app';
const app = { exe: `${bundle}/Contents/MacOS/cotal-desktop`, node: `${bundle}/Contents/MacOS/cotal-node`, cli: `${bundle}/Contents/Resources/runtime/dist/cotal.js` };
let windowProbe;

const kind = () => 'dmg';

function label() {
  const version = readFileSync('/System/Library/CoreServices/SystemVersion.plist', 'utf8').match(/<key>ProductVersion<\/key>\s*<string>([^<]+)</)?.[1];
  return `macOS ${version ?? '?'} (${process.arch === 'arm64' ? 'Apple Silicon' : 'Intel'})`;
}

async function pidOf() {
  const found = await run('pgrep', ['-f', `^${app.exe}`]);
  return Number(found.stdout.trim().split('\n')[0]) || null;
}

/** Copies Cotal.app from the disk image into /Applications, replacing an older copy as a person would. */
async function install(file) {
  const mount = mkdtempSync(join(tmpdir(), 'cotal-dmg-'));
  await must('hdiutil', ['attach', file, '-nobrowse', '-readonly', '-mountpoint', mount], { timeout: 180_000 });
  try {
    const running = await pidOf();
    if (running) throw new Error('Cotal is still running; the scenario quits it before replacing the app');
    if (existsSync(bundle)) await must('rm', ['-rf', bundle]);
    const copy = await run('ditto', [join(mount, 'Cotal.app'), bundle], { timeout: 300_000 });
    return { code: copy.code, ms: copy.ms, output: copy.code === 0 ? undefined : copy.stderr.slice(-1500) };
  } finally {
    await run('hdiutil', ['detach', mount, '-quiet'], { timeout: 60_000 });
  }
}

async function launch() {
  await must('open', [bundle]);
  for (let i = 0; i < 60; i++) {
    const pid = await pidOf();
    if (pid) return pid;
    await sleep(1000);
  }
  throw new Error('Cotal did not start within 60 s of open');
}

const probeSource = `import AppKit
let pid = Int32(CommandLine.arguments[1])!
let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as! [[String: Any]]
let mine = windows.filter { ($0[kCGWindowOwnerPID as String] as? Int32) == pid && ($0[kCGWindowLayer as String] as? Int) == 0 }
print(mine.count)
`;

/** An on-screen, normal-layer window owned by the app's process (CGWindowList needs no extra permission). */
async function window(pid, out) {
  if (!windowProbe) {
    const source = join(out, 'window-probe.swift');
    writeFileSync(source, probeSource);
    windowProbe = join(out, 'window-probe');
    await must('swiftc', ['-O', '-o', windowProbe, source], { timeout: 300_000 });
  }
  const probe = await run(windowProbe, [String(pid)]);
  return { ok: Number(probe.stdout.trim()) > 0, windows: Number(probe.stdout.trim()) || 0 };
}

async function quit(pid) {
  await run('osascript', ['-e', 'tell application id "ai.cotal.desktop" to quit'], { timeout: 30_000 });
  for (let i = 0; i < 30 && (await pidOf()) === pid; i++) await sleep(1000);
}

function leftovers(home) {
  return [bundle, join(home, '.cotal'), join(home, 'Library', 'Application Support', 'ai.cotal.desktop'), join(home, 'Library', 'LaunchAgents', 'ai.cotal.daemon.plist')].filter((path) => existsSync(path));
}

async function setHosts(block) {
  await must('sudo', ['-n', 'tee', '/etc/hosts'], { input: block(readFileSync('/etc/hosts', 'utf8')) });
  await run('sudo', ['-n', 'dscacheutil', '-flushcache']);
  await run('sudo', ['-n', 'killall', '-HUP', 'mDNSResponder']);
}

async function npmGlobal(spec) {
  return run('npm', ['install', '-g', spec], { timeout: 600_000 });
}

async function ensureNpm(directory) {
  const present = await npmOnPath();
  if (present) return { npm: present };
  const file = await nodeInstaller(/^node-v24\.\d+\.\d+\.pkg$/, directory);
  await must('sudo', ['-n', 'installer', '-pkg', file, '-target', '/'], { timeout: 300_000 });
  return { installed: file.split('/').pop(), npm: await npmOnPath() };
}

export default { app, kind, label, install, launch, window, quit, leftovers, setHosts, npmGlobal, ensureNpm };
