import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const redact = text => text.replace(/(#t=)[A-Za-z0-9_-]+/g, '$1<redacted>').replace(/eyJ[A-Za-z0-9_.-]*/g, '<redacted>');
const save = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
function run(file, args, env, cwd) {
  return new Promise(resolve => {
    const child = spawn(file, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timeout = false;
    child.stdout.on('data', b => { stdout += b; });
    child.stderr.on('data', b => { stderr += b; });
    const timer = setTimeout(() => { timeout = true; child.kill('SIGKILL'); }, 15000);
    child.once('error', error => { clearTimeout(timer); resolve({ exit: null, error: error.message, stdout: redact(stdout), stderr: redact(stderr) }); });
    child.once('close', (exit, signal) => { clearTimeout(timer); resolve({ exit, signal, timeout, stdout: redact(stdout), stderr: redact(stderr) }); });
  });
}
export async function fixtureUrl({ fixture, call, output }) {
  const result = await call('pack owned connector fixture', 'npm', ['pack', fixture, '--pack-destination', fixture, '--json']);
  assert.equal(result.exit, 0, result.stderr);
  const file = join(fixture, JSON.parse(result.stdout)[0].filename);
  const bytes = readFileSync(file);
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/fixture.tgz') { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-type': 'application/octet-stream' }).end(bytes);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/fixture.tgz`;
  save(join(output, 'fixture-url.json'), { url, sha256: createHash('sha256').update(bytes).digest('hex') });
  return { url, close: () => new Promise(resolve => server.close(resolve)) };
}
export async function observeHostedUpdate({ env, pkg, cli, project, output, cotalHome, report }) {
  const startedAt = report.startedAt;
  let count = 0, busy = Promise.resolve(), stopped = false;
  const observations = [];
  const home = join(cotalHome, 'daemon');
  async function sample(stage) {
    const index = String(count++).padStart(3, '0');
    const stem = `${index}-${stage}`;
    const observation = { at: new Date().toISOString(), stage };
    observation.unit = await run('systemctl', ['--user', 'show', 'cotal-daemon.service'], env, project);
    save(join(output, `${stem}-systemctl.json`), observation.unit);
    observation.processes = await run('ps', ['-eo', 'pid,ppid,lstart,comm'], env, project);
    save(join(output, `${stem}-processes.json`), observation.processes);
    observation.locks = await run('lslocks', ['--json', '--output', 'PID,COMMAND,TYPE,MODE,PATH'], env, project);
    save(join(output, `${stem}-locks.json`), observation.locks);
    const files = [join(home, 'daemon.log')];
    if (report.managerHost?.space) {
      const manager = join(home, `space.${Buffer.from(report.managerHost.space).toString('hex')}`, 'manager');
      files.push(join(manager, 'manager.log'), join(manager, 'manager.log.1'));
    }
    observation.logs = files.map(file => {
      if (!existsSync(file)) return { file, state: 'absent' };
      const stat = lstatSync(file);
      assert(stat.isFile() && !stat.isSymbolicLink());
      const name = `${stem}-${basename(file)}`;
      writeFileSync(join(output, name), redact(readFileSync(file, 'utf8')), { mode: 0o600 });
      return { file, state: 'copied', artifact: name };
    });
    // Only public update status records and lock path metadata. Never auth files.
    observation.updateRecords = {};
    for (const name of ['update-recovery.json', 'update-attempt.json', 'update-settings.json']) {
      const file = join(cotalHome, name);
      observation.updateRecords[name] = existsSync(file) ? JSON.parse(redact(readFileSync(file, 'utf8'))) : { state: 'absent' };
    }
    observation.lockFiles = [];
    for (const directory of [cotalHome, home, join(env.XDG_CONFIG_HOME ?? join(env.HOME, '.config'), 'cotal')]) {
      if (existsSync(directory)) for (const name of readdirSync(directory).filter(name => /lock|pending/.test(name))) {
        const file = join(directory, name), stat = lstatSync(file);
        observation.lockFiles.push({ file, mode: stat.mode, ino: stat.ino, size: stat.size });
      }
    }
    const socket = join(env.XDG_RUNTIME_DIR, 'cotal', 'daemon.sock');
    observation.socket = { path: socket, present: existsSync(socket), isSocket: existsSync(socket) && lstatSync(socket).isSocket() };
    observation.installedVersion = existsSync(join(pkg, 'package.json')) ? JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).version : 'absent';
    save(join(output, `${stem}-state.json`), observation);
    observations.push(observation);
    return observation;
  }
  const timer = setInterval(() => {
    if (stopped) return;
    busy = busy.then(() => sample('during'));
    busy.catch(error => { save(join(output, 'observer-error.json'), { error: error.message }); });
  }, 10000);
  return {
    sample,
    final: undefined,
    async close() {
      stopped = true; clearInterval(timer); await busy;
      this.final = await sample('after');
      this.final.daemonStatus = await run(process.execPath, [cli, 'daemon', 'status', '--json'], env, project);
      this.final.version = await run(process.execPath, [cli, '--version'], env, project);
      this.final.journal = await run('journalctl', ['--user', '-u', 'cotal-daemon.service', '--since', startedAt, '--no-pager', '-o', 'short-iso-precise'], env, project);
      save(join(output, 'independent-final-state.json'), this.final);
      writeFileSync(join(output, 'service-journal.log'), this.final.journal.stdout + this.final.journal.stderr, { mode: 0o600 });
      save(join(output, 'observations.json'), observations);
      const digest = readdirSync(output).filter(name => lstatSync(join(output, name)).isFile()).map(name => `${createHash('sha256').update(readFileSync(join(output, name))).digest('hex')}  ${name}`).join('\n');
      writeFileSync(join(output, 'telemetry.sha256'), digest + '\n');
    },
  };
}
