import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { countedAssert, emitSentinel, skipSuite } from './sentinel.mjs';

if (!['linux', 'darwin'].includes(process.platform)) skipSuite('POSIX global child custody');
const counted = countedAssert(assert), check = counted.assert;
const root = mkdtempSync(join(tmpdir(), 'update-child-custody-'));
const workspace = pathToFileURL(join(import.meta.dirname, '../../packages/workspace/dist/index.js')).href;
const { beginGlobalUpdateChild, claimGlobalNpmUpdateLock } = await import(workspace);
const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('COTAL_')));
const delay = () => new Promise(done => setTimeout(done, 20));
async function until(predicate) {
  const deadline = Date.now() + 10000;
  while (!predicate()) { assert(Date.now() < deadline, 'custody observation timed out'); await delay(); }
}
function run(source, cwd) {
  return spawn(process.execPath, ['--input-type=module', '-e', source], { cwd, env: clean, stdio: ['ignore', 'pipe', 'pipe'] });
}
async function exit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(done => child.once('close', done));
}
console.log(`Retained child custody evidence: ${root}`);
// A pending wrapper has no permission to mutate until the parent publishes its group.
{
  const cell = join(root, 'pending');
  mkdirSync(cell, { mode: 0o700 });
  const owner = run(`
    import { spawn } from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    const { beginGlobalUpdateChild, claimGlobalNpmUpdateLock } = await import(${JSON.stringify(workspace)});
    claimGlobalNpmUpdateLock('.');
    beginGlobalUpdateChild('.', 'install', true);
    const child = spawn('/bin/sh', ['-c', 'IFS= read -r permit <&3 && [ "$permit" = go ] || exit 125; exec 3<&-; echo forbidden > mutated'], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe'] });
    child.stdio[3].on('error', () => {});
    writeFileSync('ready', String(child.pid));
    setInterval(() => {}, 1000);
  `, cell);
  try {
    await until(() => existsSync(join(cell, 'ready')));
    check.throws(() => claimGlobalNpmUpdateLock(cell), /another cotal-ai update/);
    owner.kill('SIGKILL');
    await exit(owner);
    const release = claimGlobalNpmUpdateLock(cell);
    release();
    check.equal(existsSync(join(cell, '.cotal-update-child')), false);
    const pid = Number(readFileSync(join(cell, 'ready'), 'utf8'));
    await until(() => { try { process.kill(-pid, 0); return false; } catch (error) { if (error.code === 'ESRCH') return true; throw error; } });
    check.equal(existsSync(join(cell, 'mutated')), false, 'EOF never authorizes the preparatory wrapper');
  } finally { if (owner.exitCode === null && owner.signalCode === null) { owner.kill('SIGKILL'); await exit(owner); } }
}
// A signalled group leader does not prove its npm descendants exited.
{
  const cell = join(root, 'descendant');
  mkdirSync(cell, { mode: 0o700 });
  const releaseGlobal = claimGlobalNpmUpdateLock(cell);
  const mutation = beginGlobalUpdateChild(cell, 'reconcile', true);
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { spawn } from 'node:child_process';
    const descendant = spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify("import { existsSync, writeFileSync } from 'node:fs'; writeFileSync('ready', String(process.pid)); const timer=setInterval(() => { if(existsSync('release')) { clearInterval(timer); process.exit(0); } },20);")}], { stdio: 'ignore' });
    setInterval(() => {}, 1000);
  `], { cwd: cell, env: clean, detached: true, stdio: 'ignore' });
  try {
    mutation.markLive(child.pid);
    await until(() => existsSync(join(cell, 'ready')));
    child.kill('SIGKILL');
    await exit(child);
    mutation.complete(null, 'SIGKILL', 'reconcile child terminated by SIGKILL');
    releaseGlobal();
    const marker = readFileSync(join(cell, '.cotal-update-child'), 'utf8');
    check.equal(JSON.parse(marker).group, child.pid);
    check.throws(() => claimGlobalNpmUpdateLock(cell), /process group is still running/);
    check.equal(readFileSync(join(cell, '.cotal-update-child'), 'utf8'), marker);
    writeFileSync(join(cell, 'release'), 'release');
    await until(() => { try { process.kill(-child.pid, 0); return false; } catch (error) { if (error.code === 'ESRCH') return true; throw error; } });
    const release = claimGlobalNpmUpdateLock(cell);
    release();
    check.equal(existsSync(join(cell, '.cotal-update-child')), false);
  } finally {
    releaseGlobal();
    writeFileSync(join(cell, 'release'), 'release');
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit(child); }
  }
}
// A historical record has no group evidence. Neither elapsed time nor a dead owner proves it safe.
for (const phase of ['pending', 'ambiguous']) {
  const cell = join(root, phase + '-legacy');
  mkdirSync(cell, { mode: 0o700 });
  const marker = { phase, owner: 2147483647, nonce: '0'.repeat(24), operation: 'global reconcile', ...(phase === 'pending' ? { intermediary: false } : { reason: 'interrupted historical child' }) };
  const path = join(cell, '.cotal-update-child');
  writeFileSync(path, JSON.stringify(marker));
  check.throws(() => claimGlobalNpmUpdateLock(cell), phase === 'pending' ? /may have been orphaned/ : /ended ambiguously/);
  check.deepEqual(JSON.parse(readFileSync(path, 'utf8')), marker);
}
emitSentinel({ passed: counted.cells(), failed: 0 });
