// Sent on stdin to the explicitly authorized machine. No install or service control.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const c = JSON.parse(Buffer.from(process.argv[2], 'base64').toString());
assert(!execFileSync('hostname', [], { encoding: 'utf8' }).toLowerCase().includes('isaac24'), 'forbidden machine');
assert.equal(execFileSync('hostname', [], { encoding: 'utf8' }).trim(), c.hostname, 'fixture hostname mismatch');
assert(c.existingMachine === 'authorized-disposable-6385' && process.env.HOME === '/home/ubuntu', 'existing disposable ubuntu fixture only');
assert.equal(realpathSync(c.root), c.root, 'evidence directory must be physical');
const home = '/home/ubuntu', state = join(home, '.cotal'), prefix = c.prefix;
const env = { ...process.env, PATH: `${prefix}/nodebin:${home}/.local/bin:${process.env.PATH}`, npm_config_registry: c.registry };
const run = (cmd, args) => execFileSync(cmd, args, { cwd: c.root, env, encoding: 'utf8', timeout: 20000, maxBuffer: 4 * 1024 * 1024 });
const read = name => JSON.parse(readFileSync(join(state, name), 'utf8'));
const save = (name, value) => { const file = join(state, name), temp = `${file}.6385.tmp`; writeFileSync(temp, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 }); renameSync(temp, file); };
const sleep = () => new Promise(resolve => setTimeout(resolve, 10000));
const hash = data => createHash('sha256').update(data).digest('hex');
const cli = c.cli;
function sample() {
  const document = JSON.parse(run(cli, ['daemon', 'status', '--json']));
  assert(document.result && document.ok !== false, 'daemon status must return a successful result envelope');
  const status = document.result;
  const fields = Object.fromEntries(run('systemctl', ['--user', 'show', c.unit, '-p', 'MainPID', '-p', 'ActiveState', '-p', 'ControlGroup', '-p', 'NRestarts', '-p', 'Environment']).trim().split('\n').map(line => { const n = line.indexOf('='); return [line.slice(0, n), line.slice(n + 1)]; }));
  assert(fields.Environment !== undefined, 'native unit environment must be inspectable');
  assert.equal(fields.ActiveState, 'active'); assert.equal(Number(fields.MainPID), status.pid);
  assert.equal(status.state, 'ready'); assert(fields.ControlGroup.startsWith('/') && fields.ControlGroup !== '/');
  const cgroup = readFileSync(`/proc/${status.pid}/cgroup`, 'utf8');
  assert(cgroup.split('\n').some(line => line.endsWith(`:${fields.ControlGroup}`)), 'daemon must belong to unit cgroup');
  const stat = readFileSync(`/proc/${status.pid}/stat`, 'utf8');
  const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  const version = run(cli, ['--version']).split('\n')[0];
  assert(new RegExp(`(^|[^0-9.])${status.version.replaceAll('.', '\\.')}([^0-9.]|$)`).test(version), 'CLI and daemon version mismatch');
  return { status, unit: { MainPID: fields.MainPID, ActiveState: fields.ActiveState, ControlGroup: fields.ControlGroup, NRestarts: fields.NRestarts }, identity: `${status.pid}:${start}`, cgroup };
}
const settings = join(state, 'update-settings.json');
const backup = existsSync(settings) ? readFileSync(settings) : undefined;
const npmrc = join(home, '.npmrc');
const npmBackup = existsSync(npmrc) ? readFileSync(npmrc) : undefined;
writeFileSync(join(c.root, 'restore-policy.json'), JSON.stringify({ policy: backup?.toString('base64') ?? null, npmrc: npmBackup?.toString('base64') ?? null }) + '\n', { flag: 'wx', mode: 0o600 });
const since = new Date().toISOString();
let passed = false;
try {
  const initial = sample(); assert.equal(initial.status.version, c.parent);
  console.log(JSON.stringify({ event: 'before', sample: initial }));
  assert(!existsSync(join(home, '.config/systemd/user/cotal-daemon.service.d/6385.conf')), 'do not alter native unit for acceptance');
  run('npm', ['config', 'set', 'registry', c.registry, '--location=user']);
  run('npm', ['config', 'set', '@cotal-ai:registry', c.registry, '--location=user']);
  assert.equal(run('npm', ['view', 'cotal-ai', 'dist-tags.latest', '--registry', c.registry]).trim(), c.candidate);
  const before = read('update-attempt.json');
  run(cli, ['update', '--auto', 'on']);
  const check = read('update-check.json');
  assert(Number.isFinite(check.checkedAt) && Number.isFinite(before.next), 'existing scheduler clock records required');
  save('update-check.json', { ...check, checkedAt: Date.now() - 25 * 3600000, ...(check.attemptedAt === undefined ? {} : { attemptedAt: Date.now() - 25 * 3600000 }) });
  save('update-attempt.json', { ...before, next: 0 });
  let observed = false;
  for (let i = 0; i < 24; i++) { await sleep(); const next = read('update-check.json'); if (next.latest === c.candidate && next.checkedAt > check.checkedAt) { assert(Number.isFinite(next.firstSeenAt)); save('update-check.json', { ...next, firstSeenAt: Date.now() - 2 * 3600000 }); save('update-attempt.json', { ...read('update-attempt.json'), next: 0 }); observed = true; break; } }
  assert(observed, 'scheduler did not observe private candidate');
  let stable = 0, identity;
  for (let i = 0; i < 54; i++) {
    await sleep();
    try {
      const current = sample(), attempt = read('update-attempt.json');
      console.log(JSON.stringify({ event: 'poll', sample: current, attempt }));
      const expected = c.mode === 'success' ? c.candidate : c.parent;
      const recovery = existsSync(join(state, 'update-recovery.json')) ? read('update-recovery.json') : undefined;
      const completed = attempt.version === c.candidate && attempt.next > Date.now() && JSON.stringify(attempt) !== JSON.stringify(before) && !attempt.deferred && !attempt.result.startsWith('updating to ');
      const outcome = c.mode === 'success' ? attempt.failures === 0 : attempt.failures > 0 && /restor|roll.?back/i.test(attempt.result);
      const clean = recovery == null && !existsSync(join(prefix, 'lib/node_modules/.cotal-update-child'));
      if (current.status.version === expected && completed && outcome && clean) {
        stable = identity === current.identity ? stable + 1 : 1; identity = current.identity;
        if (stable >= 3) { if (c.mode === 'success') assert.notEqual(current.identity, initial.identity, 'candidate must replace daemon identity'); passed = true; break; }
      } else { stable = 0; identity = undefined; }
    } catch (error) { stable = 0; console.log(JSON.stringify({ event: 'unready', error: error.message })); }
  }
  assert(passed, 'no three consecutive verified-ready observations with completed attempt and cleared journal/marker');
} finally {
  // Restore only fixture policy and npm config bytes, never unit configuration.
  if (npmBackup) writeFileSync(npmrc, npmBackup, { mode: 0o600 }); else if (existsSync(npmrc)) unlinkSync(npmrc);
  if (backup) writeFileSync(settings, backup, { mode: 0o600 }); else if (existsSync(settings)) unlinkSync(settings);
  for (const name of ['update-attempt.json', 'update-check.json', 'update-recovery.json', 'update-attempt.log']) {
    const file = join(state, name);
    if (existsSync(file)) { const bytes = readFileSync(file); console.log(JSON.stringify({ event: 'evidence', name, sha256: hash(bytes), text: bytes.toString() })); }
  }
  try { const journal = run('journalctl', ['--user', '-u', c.unit, '--since', since, '--no-pager']); console.log(JSON.stringify({ event: 'journal', sha256: hash(journal), text: journal })); } catch (error) { console.log(JSON.stringify({ event: 'journal-error', error: error.message })); }
  console.log(JSON.stringify({ event: 'result', passed, policyRestored: true, npmConfigRestored: true }));
}
