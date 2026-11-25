import { open, appendFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';

const SAMPLE_MS = 350;
const SESSION_MS = 10 * 60_000;
const CAPTURE_BYTES = 2 * 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const code = error => /^[A-Z0-9_]+$/.test(error?.code ?? '') ? error.code : 'UNKNOWN';
// Drop whole suspicious lines rather than trying to guess the length of a credential.
const clean = text => text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split(/\r?\n/).slice(-64).map(line =>
  /token|secret|bearer|password|authorization|cookie|environment|\benv\b|\b[A-Z][A-Z0-9_]{2,}=|eyJ[A-Za-z0-9_-]+\.|[A-Za-z0-9_+/=-]{48,}/i.test(line)
    ? '[redacted line]' : line.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').slice(0, 512)).join('\n');

async function boundedRead(path, limit) {
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw Object.assign(new Error(), { code: 'NOT_FILE' });
    const buffer = Buffer.alloc(limit);
    const { bytesRead } = await file.read(buffer, 0, limit, Math.max(0, stat.size - limit));
    return { bytes: buffer.subarray(0, bytesRead), size: stat.size, mtimeMs: stat.mtimeMs, ino: String(stat.ino), truncated: stat.size > limit };
  } finally { await file.close(); }
}

// Read-only root-folder lookup. The validated name has no PowerShell wildcard characters.
function nativeTaskQuery(unit, { signal }) {
  if (process.platform !== 'win32') return { status: 'unknown', reason: 'NOT_WINDOWS' };
  const script = [
    "$ErrorActionPreference='Stop'",
    `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)`,
    `$name='${unit.replaceAll("'", "''")}'`,
    "try { $t=@(Get-ScheduledTask -TaskPath '\\' -TaskName $name -ErrorAction Stop) } catch { '{\"status\":\"unknown\",\"reason\":\"TASK_QUERY_FAILED\"}'; exit 0 }",
    "if($t.Count -eq 0){ '{\"present\":false}'; exit 0 }",
    "if($t.Count -ne 1){throw 'not unique'}",
    "$enabled=$null; $instances=$null",
    "try { $s=New-Object -ComObject 'Schedule.Service'; $s.Connect(); $r=$s.GetFolder('\\').GetTask($name); $enabled=[bool]$r.Enabled; $instances=[int]$r.GetInstances(0).Count } catch {}",
    "ConvertTo-Json -Compress -InputObject @{present=$true;state=[string]$t[0].State;enabled=$enabled;instances=$instances}",
  ].join('\n');
  return new Promise(resolveQuery => execFile(join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { signal, timeout: 5000, maxBuffer: 16 * 1024, windowsHide: true, encoding: 'utf8' },
    (error, stdout) => {
      if (error) return resolveQuery({ status: 'unknown', reason: code(error) });
      try { resolveQuery(JSON.parse(stdout.trim())); } catch { resolveQuery({ status: 'unknown', reason: 'INVALID_JSON' }); }
    }));
}

/** Passive diagnostic observer. Never use its receipts to decide cleanup success.
 * receipt is a service-unit.json path, output is the windows-cleanup-timings.jsonl path.
 * taskQuery(unit, {signal}) is an optional read-only test adapter. No workflow ordering lives here.
 */
export async function startCleanupTrace({ home, receipt, output, taskQuery = nativeTaskQuery }) {
  let stopped = false, written = 0, ioFailure, unit, queue = Promise.resolve();
  let interval, deadline, samples = Promise.resolve();
  const sampleNext = () => { samples = samples.then(sample).catch(() => ({ status: 'unknown', reason: 'SAMPLE_ERROR' })); return samples; };
  const controllers = new Set();
  const previous = new Map();
  const emit = async record => {
    const row = { schema: 1, at: new Date().toISOString(), ...record };
    const line = JSON.stringify(row) + '\n';
    if (written + Buffer.byteLength(line) > CAPTURE_BYTES) return { status: 'unknown', reason: 'CAPTURE_LIMIT' };
    written += Buffer.byteLength(line);
    try { await appendFile(output, line, { mode: 0o600 }); } catch (error) { ioFailure = code(error); }
    return ioFailure ? { status: 'unknown', reason: ioFailure } : row;
  };
  const enqueue = fn => { const result = queue.then(fn).catch(() => ({ status: 'unknown', reason: 'OBSERVER_ERROR' })); queue = result; return result; };
  // Refuse accidental observer writes over any observed input.
  if ([receipt, ...['daemon.lock', 'daemon.log', 'native-launcher-stderr.log'].map(name => join(home, name))].some(path => resolve(path) === resolve(output))) {
    return { checkpoint: async () => ({ status: 'unknown', reason: 'OUTPUT_IS_INPUT' }), stop: async () => ({ status: 'unknown', reason: 'OUTPUT_IS_INPUT' }) };
  }
  try {
    const source = await boundedRead(receipt, 16 * 1024);
    const record = JSON.parse(source.bytes.toString('utf8'));
    if (!source.truncated && record.mechanism === 'scheduled-task' && /^cotal-daemon-[A-Za-z0-9-]{1,180}$/.test(record.unit)) unit = record.unit;
    else await emit({ kind: 'receipt', status: 'unknown', reason: 'INVALID_RECEIPT' });
  } catch (error) { await emit({ kind: 'receipt', status: 'unknown', reason: code(error) }); }
  const sample = async () => {
    for (const name of ['daemon.lock', 'daemon.log', 'native-launcher-stderr.log']) {
      let row;
      try {
        const found = await boundedRead(join(home, name), name === 'daemon.lock' ? 4096 : 8192);
        const { bytes, ...meta } = found;
        row = { kind: 'file', name, status: 'present', ...meta, sha256: hash(bytes) };
        if (name === 'daemon.lock') {
          // The owned lock schema is secret-free. Only retain raw bytes when it validates.
          try {
            const lock = JSON.parse(bytes.toString('utf8'));
            if (!found.truncated && Number.isSafeInteger(lock.pid) && lock.pid > 0 && lock.v === 1 && typeof lock.startedAt === 'string' && Object.keys(lock).every(key => ['v', 'pid', 'start', 'startedAt', 'socket'].includes(key)) && (lock.socket === undefined || (typeof lock.socket?.path === 'string' && typeof lock.socket.dev === 'number' && typeof lock.socket.ino === 'number' && Object.keys(lock.socket).every(key => ['path', 'dev', 'ino'].includes(key)))) && (lock.start === undefined || /^[A-Za-z0-9: ._-]{1,128}$/.test(lock.start))) {
              row.raw = clean(bytes.toString('utf8')); row.pid = lock.pid; row.birth = lock.start ?? null;
            } else row.content = 'unknown';
          } catch { row.content = 'unknown'; }
        } else row.text = clean(bytes.toString('utf8'));
      } catch (error) { row = { kind: 'file', name, status: error.code === 'ENOENT' ? 'absent' : 'unknown', reason: code(error) }; }
      const fingerprint = JSON.stringify(row);
      if (previous.get(name) !== fingerprint) { previous.set(name, fingerprint); await emit(row); }
    }
  };
  const checkpoint = phase => enqueue(async () => {
    if (stopped) return { status: 'unknown', reason: 'STOPPED' };
    await sampleNext();
    const begin = Date.now();
    let task = { status: 'unknown', reason: 'NO_OWNED_TASK' };
    if (unit) {
      const controller = new AbortController(); controllers.add(controller);
      let timer;
      try {
        task = await Promise.race([
          Promise.resolve().then(() => taskQuery(unit, { signal: controller.signal })),
          new Promise(resolveTimeout => { timer = setTimeout(() => { controller.abort(); resolveTimeout({ status: 'unknown', reason: 'QUERY_TIMEOUT' }); }, 5000); }),
        ]);
        // Never serialize adapter errors, executable arguments, environment, or arbitrary fields.
        task = { status: task?.status === 'unknown' ? 'unknown' : 'observed', present: typeof task?.present === 'boolean' ? task.present : null,
          enabled: typeof task?.enabled === 'boolean' ? task.enabled : null, instances: Number.isSafeInteger(task?.instances) && task.instances >= 0 ? task.instances : null,
          state: /^(Unknown|Disabled|Queued|Ready|Running|[0-4])$/.test(String(task?.state)) ? String(task.state) : null,
          reason: /^[A-Z0-9_]+$/.test(task?.reason ?? '') ? task.reason : undefined };
      } catch (error) { task = { status: 'unknown', reason: code(error) }; }
      finally { clearTimeout(timer); controllers.delete(controller); }
    }
    return emit({ kind: 'checkpoint', phase: clean(String(phase)).slice(0, 128), unit, elapsedMs: Date.now() - begin, task });
  });
  const stop = async () => {
    if (!stopped) {
      stopped = true; clearInterval(interval); clearTimeout(deadline);
      for (const controller of controllers) controller.abort();
      await queue;
      await sampleNext();
      return emit({ kind: 'stop', status: ioFailure ? 'unknown' : 'stopped', reason: ioFailure });
    }
    await queue;
    return { status: ioFailure ? 'unknown' : 'stopped', reason: ioFailure };
  };
  await sampleNext();
  interval = setInterval(() => { if (!stopped) void sampleNext(); }, SAMPLE_MS); interval.unref();
  deadline = setTimeout(() => { void stop(); }, SESSION_MS); deadline.unref();
  return { checkpoint, stop };
}
