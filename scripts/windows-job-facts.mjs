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
  const identity = () => ({ pid: process.pid, parent: process.ppid, token: native.creationToken(process.pid), sid: native.userSid(), executable: process.execPath });
  const waitFile = async name => { const until = Date.now() + 20000; while (!existsSync(join(dir, name))) { if (Date.now() > until) throw new Error(`Timeout: ${name}`); await sleep(5); } };
  const exact = p => {
    let beforeToken = null, currentToken = null, inJob = null, queryError = null;
    try {
      beforeToken = native.creationToken(p.pid) ?? null;
      const result = native.inJob(p.pid); inJob = result === undefined ? null : result;
      currentToken = native.creationToken(p.pid) ?? null;
    } catch (error) { queryError = String(error); }
    return { ...p, beforeToken, inJob, queryError, currentToken };
  };
  const requireContained = facts => { if (facts.some(p => p.inJob !== true || p.queryError || p.beforeToken !== p.token || p.currentToken !== p.token)) throw new Error('Exact membership/identity unknown or outside workspace job'); };
  if (mode === 'grandchild') {
    save('grandchild.json', { ...identity(), role: 'grandchild' });
    const until = Date.now() + 120000;
    while (!existsSync(join(dir, 'quiesce')) && Date.now() < until) await sleep(5);
  } else if (mode === 'child') {
    const grand = spawn(process.execPath, [process.argv[1], 'grandchild', dir, packageRoot, helper], { stdio: 'ignore', windowsHide: true });
    grand.on('error', error => { throw error; });
    save('child.json', { ...identity(), role: 'root', grandchildPid: grand.pid });
    await waitFile('grandchild.json');
    const attempt = spawn(helper, ['breakaway', dir, process.execPath, process.argv[1], packageRoot, helper], { stdio: 'ignore', windowsHide: true });
    attempt.on('error', error => { throw error; });
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
    save('runner-integrity.json', { identity: identity(), scope: 'Runner SID only. Context helper token groups recorded separately, no inference about runner integrity' });
    const facts = spawnSync(helper, ['context', dir, String(process.pid)], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    if (facts.status !== 0) throw new Error(`scheduler context: ${facts.stderr}`);
    save('ephemeral-context.json', { ...JSON.parse(readFileSync(join(dir, 'scheduler-job.json'), 'utf8')), exitStatus: facts.status, exactWorkspaceMembership: 'not applicable: workspace job not created yet', exitedBeforeLaunch: true });
    const log = join(dir, 'child.log'); writeFileSync(log, '', { flag: 'wx' });
    const root = native.launch({ application: process.execPath,
      commandLine: api.windowsCommandLine(process.execPath, [process.argv[1], 'child', dir, packageRoot, helper]),
      cwd: dir, environment: api.windowsEnvironmentBlock({}, process.env), log });
    const until = Date.now() + 120000;
    while ((!existsSync(join(dir, 'child.json')) || !existsSync(join(dir, 'grandchild.json'))) && Date.now() < until) await sleep(5);
    const child = JSON.parse(readFileSync(join(dir, 'child.json'), 'utf8'));
    const grandchild = JSON.parse(readFileSync(join(dir, 'grandchild.json'), 'utf8'));
    await waitFile('helper-ready.json');
    const helperIdentity = JSON.parse(readFileSync(join(dir, 'helper-ready.json'), 'utf8'));
    const beforeRequest = [child, { ...grandchild, role: 'grandchild' }, helperIdentity].map(exact);
    save('before-request.json', { membership: beforeRequest, members: native.jobProcesses() });
    requireContained(beforeRequest);
    writeFileSync(join(dir, 'breakaway-request'), '', { flag: 'wx' });
    await waitFile('breakaway.json');
    const breakaway = JSON.parse(readFileSync(join(dir, 'breakaway.json'), 'utf8'));
    const census = [child, { ...grandchild, role: 'grandchild' }, helperIdentity];
    if (breakaway.created) census.push(breakaway.identity);
    save('breakaway-result.json', { breakaway, membership: breakaway.created ? exact(breakaway.identity) : null });
    if (!breakaway.created && breakaway.lastError !== 5) throw new Error('Unknown breakaway refusal');
    const membership = census.map(exact);
    const members = native.jobProcesses();
    save('armed-census.json', { root, census, members, membership, breakaway });
    // A successful creation is not an escape. Only the exact workspace-job result decides.
    if (breakaway.created && membership.at(-1).inJob === false) throw new Error('FAIL: created process escaped exact workspace job, retained for bounded self-expiry');
    requireContained(membership);
    const known = census.map(p => p.pid).sort((a, b) => a - b);
    if (JSON.stringify([...members].sort((a, b) => a - b)) !== JSON.stringify(known)) throw new Error('Full live job census differs from known created processes');
    if (root.pid !== child.pid || root.token !== child.token) throw new Error('Launcher root identity mismatch');
    save('ready.json', { root, child, grandchild, census, members, membership, breakaway });
    while (!existsSync(join(dir, 'normal')) && Date.now() < until) await sleep(5);
    if (!existsSync(join(dir, 'normal'))) throw new Error('Runner expiry without controller');
    writeFileSync(join(dir, 'quiesce'), '');
    while (native.jobProcesses().length !== 0 && Date.now() < until) await sleep(1);
    if (native.jobProcesses().length !== 0) throw new Error('Native job not empty');
    save('quiesced.json', { members: native.jobProcesses(), monotonicNs: process.hrtime.bigint().toString() });
    closeSync(fd);
    save('released.json', { monotonicNs: process.hrtime.bigint().toString() });
  } else if (mode === 'escape') {
    save('escape.json', { ...identity(), role: 'breakaway-created' });
    const until = Date.now() + 120000;
    while (!existsSync(join(dir, 'quiesce')) && Date.now() < until) await sleep(5);
  } else throw new Error('Unknown worker mode');
} catch (error) {
  save(`${mode}-failure.json`, { error: String(error.stack || error) });
  process.exitCode = 1;
}
