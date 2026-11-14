import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
assert.equal(process.platform, 'linux');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
const evidence = join(process.env.RUNNER_TEMP, 'update-duration-evidence');
mkdirSync(evidence, { recursive: true, mode: 0o700 });
const timeoutMs = Number(process.env.UPDATE_DIAGNOSTIC_TIMEOUT_MS ?? 600000);
assert(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 600000);
const log = join(evidence, 'measure-live.log');
const driver = resolve(process.argv[2]);
const child = spawn(process.execPath, [driver], { env: process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
const stream = (name, bytes) => { appendFileSync(log, bytes); process[name].write(bytes); };
child.stdout.on('data', bytes => stream('stdout', bytes));
child.stderr.on('data', bytes => stream('stderr', bytes));
function dump() {
  const processes = spawnSync('ps', ['-eo', 'pid,ppid,pgid,stat,etime,comm'], { encoding: 'utf8' });
  writeFileSync(join(evidence, 'timeout-processes.txt'), `${processes.stdout}\n${processes.stderr}`);
  const root = join(process.env.RUNNER_TEMP, `update-duration-${process.env.SAMPLE}`);
  const files = [];
  const walk = directory => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink() || entry.name === 'node_modules' || entry.name === 'npm-cache') continue;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && (/\.log$/.test(entry.name) || /^\.extensions.*(?:lock|json)$/.test(entry.name) || /^reconcile\.(?:lock|cursor\.json|child\.json)$/.test(entry.name))) {
        const size = lstatSync(path).size;
        if (size <= 8 * 1024 * 1024) files.push({ path: path.slice(root.length), size, text: readFileSync(path, 'utf8') });
        else files.push({ path: path.slice(root.length), size, omitted: 'larger than 8 MiB' });
      }
    }
  };
  walk(root);
  writeFileSync(join(evidence, 'timeout-update-daemon-logs.json'), JSON.stringify({ at: new Date().toISOString(), child: child.pid, files }, null, 2));
}
let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  try { dump(); }
  catch (error) { writeFileSync(join(evidence, 'timeout-dump-error.txt'), String(error.stack ?? error)); }
  writeFileSync(join(evidence, 'timeout.json'), JSON.stringify({ timeoutMs, message: 'measurement exceeded ten-minute bound; original child output and process/log snapshot retained' }));
  // This group was created by this driver and contains only this disposable measurement's children.
  process.kill(-child.pid, 'SIGTERM');
  const kill = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }, 5000);
  kill.unref();
}, timeoutMs);
child.once('error', error => { clearTimeout(timer); throw error; });
const result = await new Promise(done => child.once('close', (status, signal) => done({ status, signal })));
clearTimeout(timer);
writeFileSync(join(evidence, 'measure-exit.json'), JSON.stringify({ ...result, timedOut }));
if (timedOut || result.status !== 0 || result.signal) process.exitCode = 1;
