// Harness only. One published native launch per runner process. No product imports from this checkout.
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { openSync, closeSync, writeFileSync, renameSync, existsSync, readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { connect } from 'node:net';
const [mode, dir, packageRoot, helper, pipeName] = process.argv.slice(2);
const save = (name, value) => { const p = join(dir, name); writeFileSync(p + '.tmp', JSON.stringify(value), { flag: 'wx' }); renameSync(p + '.tmp', p); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  if (process.platform !== 'win32') throw new Error('Native Windows required');
  const rootVersion = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version;
  if (rootVersion !== '0.164.6') throw new Error(`Expected published 0.164.6, got ${rootVersion}`);
  const workspace = join(packageRoot, 'node_modules', '@cotal-ai', 'workspace');
  const seatRoot = join(packageRoot, 'node_modules', '@cotal-ai', 'seat');
  for (const [root, name] of [[workspace, '@cotal-ai/workspace'], [seatRoot, '@cotal-ai/seat']]) {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    if (manifest.name !== name || manifest.version !== '0.164.6') throw new Error(`Unexpected published package ${root}`);
  }
  const api = await import(pathToFileURL(join(workspace, 'dist/win32-process.js')).href);
  const native = api.win32ProcessBinding();
  const identity = () => ({ pid: process.pid, token: native.creationToken(process.pid), sid: native.userSid(), executable: process.execPath });
  if (mode === 'grandchild') {
    save('grandchild.json', identity());
    const until = Date.now() + 120000;
    while (!existsSync(join(dir, 'quiesce')) && Date.now() < until) await sleep(5);
  } else if (mode === 'child') {
    const grand = spawn(process.execPath, [process.argv[1], 'grandchild', dir, packageRoot, helper], { stdio: 'ignore', windowsHide: true });
    grand.on('error', error => { throw error; });
    const attempt = spawnSync(helper, ['breakaway', dir, process.execPath, process.argv[1], packageRoot, helper], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    if (attempt.status !== 0) throw new Error(`breakaway helper: ${attempt.stderr}`);
    save('child.json', { ...identity(), grandchildPid: grand.pid });
    const until = Date.now() + 120000;
    while (!existsSync(join(dir, 'quiesce')) && Date.now() < until) await sleep(5);
    await new Promise(resolve => { if (grand.exitCode !== null) resolve(); else grand.once('exit', resolve); });
  } else if (mode === 'runner') {
    const seat = await import(pathToFileURL(join(seatRoot, 'dist/index.js')).href);
    const fd = openSync(join(dir, 'gate.bin'), 'r+');
    if (!seat.lockExclusiveNb(fd)) throw new Error('Initial exclusive gate refused');
    save('runner.json', { ...identity(), rootVersion, workspace, seat: seatRoot });
    await new Promise((resolve, reject) => {
      const pipe = connect(pipeName, () => pipe.end(JSON.stringify(identity()) + '\n'));
      pipe.once('error', reject); pipe.once('close', resolve);
    });
    // This helper inherits the action's scheduler job. It never opens a job handle.
    const integrity = spawnSync(join(process.env.SystemRoot, 'System32', 'whoami.exe'), ['/all', '/fo', 'csv'], { encoding: 'utf8', timeout: 10000 });
    if (integrity.status !== 0) throw new Error(`runner integrity query failed: ${integrity.stderr}`);
    save('runner-integrity.json', { output: integrity.stdout });
    const facts = spawnSync(helper, ['context', dir, String(process.pid)], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    if (facts.status !== 0) throw new Error(`scheduler context: ${facts.stderr}`);
    const log = join(dir, 'child.log'); writeFileSync(log, '', { flag: 'wx' });
    const root = native.launch({ application: process.execPath,
      commandLine: api.windowsCommandLine(process.execPath, [process.argv[1], 'child', dir, packageRoot, helper]),
      cwd: dir, environment: api.windowsEnvironmentBlock({}, process.env), log });
    const until = Date.now() + 120000;
    while ((!existsSync(join(dir, 'child.json')) || !existsSync(join(dir, 'grandchild.json'))) && Date.now() < until) await sleep(5);
    const child = JSON.parse(readFileSync(join(dir, 'child.json'), 'utf8'));
    const grandchild = JSON.parse(readFileSync(join(dir, 'grandchild.json'), 'utf8'));
    const breakaway = JSON.parse(readFileSync(join(dir, 'breakaway.json'), 'utf8'));
    const members = native.jobProcesses();
    const membership = [child, grandchild].map(p => ({ ...p, inJob: native.inJob(p.pid), currentToken: native.creationToken(p.pid) }));
    if (membership.some(p => p.inJob !== true || p.token !== p.currentToken) || !members.includes(child.pid) || !members.includes(grandchild.pid)) throw new Error('Native job membership/identity failed');
    if (breakaway.created) throw new Error('CREATE_BREAKAWAY_FROM_JOB succeeded, possible escape');
    save('ready.json', { root, child, grandchild, members, membership, breakaway });
    while (!existsSync(join(dir, 'normal')) && Date.now() < until) await sleep(5);
    if (!existsSync(join(dir, 'normal'))) throw new Error('Runner expiry without controller');
    writeFileSync(join(dir, 'quiesce'), '');
    while (native.jobProcesses().length !== 0 && Date.now() < until) await sleep(1);
    if (native.jobProcesses().length !== 0) throw new Error('Native job not empty');
    save('quiesced.json', { members: native.jobProcesses(), monotonicNs: process.hrtime.bigint().toString() });
    closeSync(fd);
    save('released.json', { monotonicNs: process.hrtime.bigint().toString() });
  } else if (mode === 'escape') {
    save('escape.json', identity());
    await sleep(120000);
  } else throw new Error('Unknown worker mode');
} catch (error) {
  save(`${mode}-failure.json`, { error: String(error.stack || error) });
  process.exitCode = 1;
}
