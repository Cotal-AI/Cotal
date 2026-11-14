import assert from 'node:assert/strict';
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, win32 } from 'node:path';
import { createHash } from 'node:crypto';
import { redactDiagnostic } from './hosted-consent-diagnostics.mjs';

const LIMIT = 256 * 1024;
export const daemonShowProperties = Object.freeze(['Id', 'LoadState', 'UnitFileState', 'ControlGroup', 'ActiveState', 'SubState', 'Result', 'MainPID', 'ExecMainPID', 'ExecMainCode', 'ExecMainStatus', 'NRestarts', 'ActiveEnterTimestamp', 'InactiveEnterTimestamp', 'InvocationID']);
const fields = new Set(['v', 'hash', 'firstObservedAt', 'current', 'latest', 'nextAttempt', 'snapshot', 'code', 'message', 'reason', 'remedy', 'outcome', 'pid', 'start', 'startedAt', 'recordedAt', 'phase', 'previous', 'target', 'installed', 'preparedRestart', 'version', 'failures', 'result', 'next', 'deferred', 'automatic', 'auto', 'notify', 'owner', 'socket', 'path', 'dev', 'ino', 'ts', 'done', 'state', 'uptime', 'uptimeMs', 'update', 'lastResult', 'lastCheck', 'nextCheck', 'label', 'sha256']);
function project(value, depth = 0) {
  if (depth > 6) return '<depth-limit>';
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  if (Array.isArray(value)) return '<omitted-array>';
  return Object.fromEntries(Object.entries(value).filter(([key]) => fields.has(key)).map(([key, item]) => [key, project(item, depth + 1)]));
}
function clean(text) {
  const sensitive = /(?:["']?\b(?:environment|env|argv|authorization|password|secret|credential|credentials|token|access_token|refresh_token|ExecStart|ProgramArguments)\b["']?\s*[:=]|\bBearer\s+\S+|--(?:password|token|secret|credential)(?:=|\s))/i;
  let depth = 0;
  // Count only structural brackets outside quoted strings, including escaped JSON quotes.
  const balance = line => {
    let delta = 0, quoted = false, escaped = false;
    for (const char of line) {
      if (escaped) { escaped = false; continue; }
      if (quoted && char === '\\') { escaped = true; continue; }
      if (char === '"') { quoted = !quoted; continue; }
      if (!quoted && (char === '{' || char === '[')) delta++;
      if (!quoted && (char === '}' || char === ']')) delta--;
    }
    return delta;
  };
  return redactDiagnostic(String(text)).split('\n').map(line => {
    if (depth > 0) { depth = Math.max(0, depth + balance(line)); return '<sensitive-section-omitted>'; }
    if (!sensitive.test(line)) return line;
    depth = Math.max(0, balance(line));
    return '<sensitive-line-omitted>';
  }).join('\n');
}
function owned(stat) {
  if (process.getuid) assert.equal(stat.uid, process.getuid(), 'owner differs');
}
function directory(path) {
  assert(typeof path === 'string' && isAbsolute(path) && resolve(path) === path, 'root must be absolute and normalized');
  assert.equal(realpathSync(path), path, 'symlink parent refused');
  const stat = lstatSync(path);
  assert(stat.isDirectory() && !stat.isSymbolicLink(), 'root is not a directory');
  owned(stat);
  if (process.getuid) assert.equal(stat.mode & 0o022, 0, 'writable root refused');
  return stat;
}
function safePath(root, file) {
  directory(root);
  assert(file.startsWith(root + '/') || file.startsWith(root + '\\'), 'path escaped root');
  for (let parent = dirname(file); parent !== root; parent = dirname(parent)) directory(parent);
  assert.equal(realpathSync(file), file, 'symlink file refused');
  const stat = lstatSync(file);
  owned(stat);
  assert(!stat.isSymbolicLink(), 'symlink refused');
  return stat;
}
function bytes(root, file) {
  const before = safePath(root, file);
  assert(before.isFile() && before.nlink === 1, 'not an exclusive regular file');
  if (process.getuid) assert.equal(before.mode & 0o022, 0, 'writable file refused');
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = fstatSync(fd);
    assert(stat.isFile() && stat.ino === before.ino && stat.dev === before.dev, 'source changed');
    assert(stat.size <= LIMIT, 'source exceeds byte limit');
    const buffer = Buffer.alloc(LIMIT + 1);
    const count = readSync(fd, buffer, 0, buffer.length, 0);
    assert(count <= LIMIT, 'source exceeds byte limit');
    const after = safePath(root, file);
    assert(after.ino === stat.ino && after.dev === stat.dev, 'source changed');
    return buffer.subarray(0, count).toString('utf8');
  } finally { closeSync(fd); }
}
const failure = error => ({ state: error?.code === 'ENOENT' ? 'missing' : error?.code === 'ETIMEDOUT' || error?.name === 'AbortError' ? 'timeout' : 'error', error: clean(error?.code === 'ERR_ASSERTION' ? error.message : error?.code ?? error?.message ?? 'diagnostic error') });

/** Read-only snapshots before/after an update. No verdict interpretation, lock operation, or service control.
 * run(file, argv, {timeoutMs,maxBuffer,signal}) must enforce the bounds and reap its children before
 * settling. daemonStatus(bounds) is the independent public CLI status runner, with the same contract.
 * pkg is the installed package directory, config is the Cotal config directory, plan.globalRoot is
 * npm's global package root. socket is optional and metadata-only (Windows pipes are not opened).
 * The returned verdict is the original value by identity. Collection failures never reject.
 */
export async function captureDaemonDiagnostics(options = {}) {
  try { return await capture(options); }
  catch (error) { return { stage: options?.stage, verdict: options?.verdict, observations: [{ kind: 'collector', ...failure(error) }] }; }
}
async function capture(options) {
  const report = { stage: options.stage, capturedAt: new Date().toISOString(), verdict: options.verdict, observations: [] };
  const add = async (kind, action) => {
    try { report.observations.push({ kind, ...await action() }); }
    catch (error) { report.observations.push({ kind, ...failure(error) }); }
  };
  let outputStat;
  const archive = (kind, text) => {
    assert(outputStat, 'invalid output root');
    const current = directory(options.output);
    assert(current.ino === outputStat.ino && current.dev === outputStat.dev, 'output root changed');
    const artifact = `${options.id}-daemon-${options.stage}-${kind}.txt`;
    const data = Buffer.from(text);
    assert(data.length <= LIMIT * 2, 'artifact exceeds byte limit');
    writeFileSync(join(options.output, artifact), data, { flag: 'wx', mode: 0o600 });
    return { artifact, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
  };
  await add('roots', () => {
    assert.match(options.id, /^[A-Za-z0-9_.-]{1,160}$/);
    assert.match(options.stage, /^[a-z][a-z-]{0,40}$/);
    outputStat = directory(options.output);
    for (const key of ['home', 'cotalHome', 'daemonHome', 'config', 'pkg']) directory(options[key]);
    return { state: 'observed' };
  });
  const file = async (kind, root, path, json = true) => add(kind, () => {
    const text = bytes(root, path);
    const value = json ? JSON.parse(text) : undefined;
    let ownerProcess;
    const owner = value?.owner ?? value;
    if (json && (options.platform ?? process.platform) === 'linux' && Number.isSafeInteger(owner?.pid) && owner.pid > 0) {
      try {
        const fd = openSync(`/proc/${owner.pid}/stat`, constants.O_RDONLY | constants.O_NOFOLLOW);
        let stat;
        try {
          const buffer = Buffer.alloc(8192);
          const count = readSync(fd, buffer, 0, buffer.length, 0);
          assert(count < buffer.length, 'process stat exceeds bound');
          stat = buffer.subarray(0, count).toString();
        } finally { closeSync(fd); }
        const parts = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
        ownerProcess = { state: 'observed', pid: owner.pid, processState: parts[0], start: parts[19], startMatches: typeof owner.start === 'string' ? parts[19] === owner.start : null, interpretation: 'PID/start observation only, not kernel lock custody' };
      } catch (error) { ownerProcess = failure(error); }
    }
    return { state: 'archived', ...archive(kind, json ? clean(JSON.stringify({ record: project(value), ...(ownerProcess ? { ownerProcess } : {}) }, null, 2)) : clean(text)) };
  });
  // Fixed names only. No service receipt, environment, credential tree, plist, or agent inventory.
  for (const name of ['daemon.log', 'daemon.log.1', 'daemon.log.2']) await file(name, options.daemonHome, join(options.daemonHome ?? '', name), false);
  await file('daemon.lock', options.daemonHome, join(options.daemonHome ?? '', 'daemon.lock'));
  for (const name of ['update-settings.json', 'update-recovery.json', 'update-recovery-observed.json', 'update-attempt.json', 'update-check.json', 'update-check.lock', 'update-launchd.json', 'update-launchd-result.json']) await file(name, options.cotalHome, join(options.cotalHome ?? '', name));
  await file('update-attempt.log', options.cotalHome, join(options.cotalHome ?? '', 'update-attempt.log'), false);
  for (const name of ['.extensions.lock', '.extensions.lock.update', '.extensions.lock.npm-child']) await file(name, options.config, join(options.config ?? '', name));
  if (options.plan?.globalRoot) for (const name of ['.cotal-update.lock', '.cotal-update-child']) await file(name, options.plan.globalRoot, join(options.plan.globalRoot, name));
  else report.observations.push({ kind: 'global-update-owner', state: 'unavailable', reason: 'plan.globalRoot not supplied' });
  await add('installed-version', () => {
    const value = JSON.parse(bytes(options.pkg, join(options.pkg, 'package.json')));
    assert.equal(value.name, 'cotal-ai', 'unexpected package');
    assert.match(value.version, /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/);
    return { state: 'archived', version: value.version, ...archive('installed-version', JSON.stringify({ name: value.name, version: value.version })) };
  });
  await add('socket', () => {
    if ((options.platform ?? process.platform) === 'win32') return { state: 'unavailable', reason: 'named-pipe metadata requires native observer; pipe not opened' };
    const recorded = options.socket ? undefined : JSON.parse(bytes(options.daemonHome, join(options.daemonHome, 'daemon.lock')))?.socket;
    const socket = options.socket ?? recorded?.path;
    assert(typeof socket === 'string' && isAbsolute(socket), 'no socket supplied or recorded');
    const stat = safePath(dirname(socket), socket);
    if (recorded) assert(stat.dev === recorded.dev && stat.ino === recorded.ino, 'recorded socket generation differs');
    assert(stat.isSocket(), 'endpoint is not a socket');
    return { state: 'archived', ...archive('socket', JSON.stringify({ source: options.socket ? 'explicit' : 'daemon.lock', dev: stat.dev, ino: stat.ino, uid: stat.uid, mode: stat.mode, mtimeMs: stat.mtimeMs })) };
  });
  await add('kernel-lock', () => {
    if ((options.platform ?? process.platform) !== 'linux') return { state: 'unavailable', reason: 'no read-only native kernel-lock reader supplied; owner record is not kernel custody proof' };
    const targets = [[options.daemonHome, 'daemon.lock']];
    const observed = [];
    // proc is the kernel interface, not a product source root. Never archive foreign lock rows.
    const fd = openSync('/proc/locks', constants.O_RDONLY | constants.O_NOFOLLOW);
    let text;
    try {
      const buffer = Buffer.alloc(1024 * 1024 + 1);
      let count = 0;
      while (count < buffer.length) {
        const read = readSync(fd, buffer, count, buffer.length - count, null);
        if (read === 0) break;
        count += read;
      }
      assert(count < buffer.length, 'kernel lock table exceeds bound');
      text = buffer.subarray(0, count).toString();
    } finally { closeSync(fd); }
    for (const [root, name] of targets) {
      if (!root) { observed.push({ name, state: 'unavailable' }); continue; }
      try {
        const stat = safePath(root, join(root, name));
        assert(stat.isFile(), 'lock is not a regular file');
        const dev = BigInt(stat.dev);
        const major = Number(((dev >> 8n) & 0xfffn) | ((dev >> 32n) & 0xfffff000n));
        const minor = Number((dev & 0xffn) | ((dev >> 12n) & 0xffffff00n));
        const matches = text.split('\n').filter(line => {
          const match = line.match(/\b([a-fA-F0-9]+):([a-fA-F0-9]+):(\d+)\b/);
          return match && parseInt(match[1], 16) === major && parseInt(match[2], 16) === minor && match[3] === String(stat.ino);
        });
        observed.push({ name, state: 'observed', dev: stat.dev, ino: stat.ino, matches, interpretation: 'instantaneous visible kernel rows only; absence does not establish lock freedom' });
      } catch (error) { observed.push({ name, ...failure(error) }); }
    }
    return { state: 'archived', ...archive('kernel-lock', JSON.stringify(observed)) };
  });
  const command = async (kind, callback, filter = value => value) => add(kind, async () => {
    assert.equal(typeof callback, 'function', 'runner not supplied');
    const timeoutMs = options.timeoutMs ?? 5000;
    assert(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30000, 'invalid diagnostic timeout');
    const startedAt = new Date().toISOString();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const result = await callback({ timeoutMs, maxBuffer: LIMIT, signal: controller.signal });
      const exit = result?.exit ?? result?.status ?? null;
      const timedOut = controller.signal.aborted || result?.timedOut === true || result?.timeout === true || result?.error?.code === 'ETIMEDOUT';
      const stdout = String(result?.stdout ?? ''), stderr = String(result?.stderr ?? '');
      assert(Buffer.byteLength(stdout) + Buffer.byteLength(stderr) <= LIMIT, 'runner exceeded byte limit');
      return { state: timedOut ? 'timeout' : result?.truncated ? 'truncated' : exit === 0 ? 'observed' : 'failed', exit, ...archive(kind, JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), exit, timedOut, truncated: result?.truncated === true, signal: result?.signal ?? null, stdout: clean(filter(stdout)), stderr: clean(stderr), ...(result?.error ? { error: failure(result.error) } : {}) })) };
    } finally { clearTimeout(timer); }
  });
  if ((options.platform ?? process.platform) === 'linux') {
    await command('systemctl-show', bounds => options.run('systemctl', ['--user', 'show', 'cotal-daemon.service', ...daemonShowProperties.map(key => `--property=${key}`)], bounds), text => text.split('\n').filter(line => daemonShowProperties.includes(line.split('=')[0])).join('\n'));
    await command('journal', bounds => {
      assert(typeof options.startedAt === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(options.startedAt) && Number.isFinite(Date.parse(options.startedAt)), 'cell start must be an ISO UTC timestamp');
      return options.run('journalctl', ['--user', '-u', 'cotal-daemon.service', '--since', options.startedAt, '--no-pager', '--output', 'short-iso-precise'], bounds);
    });
  }
  if ((options.platform ?? process.platform) === 'darwin') {
    const unit = () => {
      assert.match(options.plan?.unit ?? '', /^ai\.cotal\.daemon(?:\.[a-f0-9]{16})?$/);
      assert(Number.isSafeInteger(process.getuid?.()), 'native user id unavailable');
      return options.plan.unit;
    };
    await command('launchctl-print', bounds => options.run('/bin/launchctl', ['print', `gui/${process.getuid()}/${unit()}`], bounds), text => text.split('\n').map(line => line.trim()).filter(line => /^(?:state|pid|last exit code) = [A-Za-z0-9 -]+$/.test(line)).join('\n'));
    await command('launchctl-disabled', bounds => {
      unit();
      return options.run('/bin/launchctl', ['print-disabled', `gui/${process.getuid()}`], bounds);
    }, text => {
      if (!text.trim()) return '';
      assert(/^\s*disabled services = \{[\s\S]*\}\s*$/.test(text), 'invalid native disabled listing');
      const lines = text.split('\n').map(line => line.trim()).filter(line => line.startsWith(`"${unit()}" => `));
      assert(lines.length <= 1, 'duplicate native disabled entry');
      const disabled = lines.length === 0 ? false : /=> true$/.test(lines[0]) ? true : /=> false$/.test(lines[0]) ? false : undefined;
      assert(typeof disabled === 'boolean', 'invalid native disabled entry');
      return JSON.stringify({ unit: unit(), disabled });
    });
  }
  if ((options.platform ?? process.platform) === 'win32') {
    await command('scheduled-task', bounds => {
      const unit = options.plan?.unit;
      assert.match(unit ?? '', /^cotal-daemon-(?:[a-f0-9]{16}-)?S-1-[0-9]+(?:-[0-9]+)+$/);
      const root = process.env.SystemRoot ?? process.env.windir;
      assert(typeof root === 'string' && win32.isAbsolute(root), 'Windows system directory unavailable');
      const script = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $task=Get-ScheduledTask -TaskPath '\\' -TaskName '${unit}'; $info=Get-ScheduledTaskInfo -InputObject $task; [pscustomobject]@{Name=[string]$task.TaskName;State=[string]$task.State;Enabled=[bool]$task.Settings.Enabled;LastResult=$info.LastTaskResult}|ConvertTo-Json -Compress`;
      return options.run(win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], bounds);
    }, text => {
      if (!text.trim()) return '';
      const value = JSON.parse(text.replace(/^\uFEFF/, ''));
      return JSON.stringify({ Name: value.Name, State: value.State, Enabled: value.Enabled, LastResult: value.LastResult });
    });
  }
  // Always independent of file/service observations, including when an earlier capture failed.
  await command('daemon-status', options.daemonStatus ?? (bounds => {
    assert(typeof options.cli?.file === 'string' && Array.isArray(options.cli.args), 'public CLI route not supplied');
    return options.run(options.cli.file, [...options.cli.args, 'daemon', 'status', '--json'], bounds);
  }), text => text.trim() ? JSON.stringify(project(JSON.parse(text))) : '');
  return report;
}
