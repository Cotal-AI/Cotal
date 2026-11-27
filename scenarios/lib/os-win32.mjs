import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { nodeInstaller, npmOnPath } from './node-install.mjs';
import { must, productEnv, run, shell } from './proc.mjs';

const root = join(process.env.LOCALAPPDATA ?? '', 'Cotal');
const app = { exe: join(root, 'cotal-desktop.exe'), node: join(root, 'node.exe'), cli: join(root, 'runtime', 'dist', 'cotal.js') };
const hostsFile = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts');

const kind = () => 'exe';

async function label() {
  const os = await shell('(Get-CimInstance Win32_OperatingSystem).Caption');
  return os.stdout.trim().replace(/^Microsoft /, '') || 'Windows';
}

/** The published per-user NSIS setup, silent, the way an update or an unattended install runs it. */
async function install(file) {
  const result = await run(file, ['/S'], { timeout: 420_000 });
  return { code: result.code, ms: result.ms, output: result.code === 0 ? undefined : (result.stderr || result.stdout).slice(-1500) };
}

async function launch() {
  const child = spawn(app.exe, [], { env: productEnv(), detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  return child.pid;
}

async function window(pid) {
  const probe = await shell(`$p = Get-Process -Id ${Number(pid)} -ErrorAction Stop; $p.Refresh(); @{ handle = [int64]$p.MainWindowHandle; title = $p.MainWindowTitle } | ConvertTo-Json -Compress`, { timeout: 30_000 });
  try {
    const row = JSON.parse(probe.stdout);
    return { ok: row.handle !== 0 && row.title === 'Cotal', title: row.title };
  } catch {
    return { ok: false, output: probe.stderr.trim().slice(-300) };
  }
}

async function quit(pid) {
  await shell(`Stop-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue`);
}

function leftovers(home) {
  return [root, join(home, '.cotal'), join(process.env.LOCALAPPDATA ?? '', 'CotalSetup')].filter((path) => existsSync(path));
}

async function setHosts(block) {
  const next = block(readFileSync(hostsFile, 'utf8'));
  await must('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `[IO.File]::WriteAllText('${hostsFile}', [Console]::In.ReadToEnd()); ipconfig /flushdns | Out-Null`], { input: next });
}

async function npmGlobal(spec) {
  return shell(`npm install -g ${spec}`, { timeout: 600_000 });
}

/** The Node MSI updates the stored PATH; this process adds the same folders so its next commands find npm. */
async function ensureNpm(directory) {
  const present = await npmOnPath();
  if (present) return { npm: present };
  const file = await nodeInstaller(/^node-v24\.\d+\.\d+-x64\.msi$/, directory);
  await must('msiexec.exe', ['/i', file, '/qn', '/norestart'], { timeout: 600_000 });
  process.env.Path = `${process.env.Path};${join(process.env.ProgramFiles ?? 'C:\\Program Files', 'nodejs')};${join(process.env.APPDATA ?? '', 'npm')}`;
  return { installed: file.split('\\').pop(), npm: await npmOnPath() };
}

export default { app, kind, label, install, launch, window, quit, leftovers, setHosts, npmGlobal, ensureNpm };
