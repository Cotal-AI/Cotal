import { appendFileSync } from 'node:fs';
import { createRequire, registerHooks, syncBuiltinESMExports } from 'node:module';
import { threadId } from 'node:worker_threads';

const require = createRequire(import.meta.url);
const childProcess = require('node:child_process');
const threads = require('node:worker_threads');
const output = process.env.OWNERSHIP_TIMING_LOG;
if (!output) throw new Error('OWNERSHIP_TIMING_LOG is required');
const emit = (event) => appendFileSync(output, `${JSON.stringify({ at: performance.timeOrigin + performance.now(), threadId, ...event })}\n`);
emit({ kind: 'preload' });
registerHooks({
  load(url, context, nextLoad) {
    const started = performance.now();
    const loaded = nextLoad(url, context);
    emit({ kind: 'module', url, loadMs: performance.now() - started });
    return loaded;
  },
});
const originalSpawn = childProcess.spawnSync;
childProcess.spawnSync = function(file, args, options) {
  const started = performance.timeOrigin + performance.now();
  emit({ kind: 'native-start', file });
  let measured = args;
  if (/powershell\.exe$/i.test(file)) {
    const at = args.indexOf('-EncodedCommand');
    if (at < 0) throw new Error('Expected the fixed encoded task read');
    const script = Buffer.from(args[at + 1], 'base64').toString('utf16le');
    const lines = script.split('\n');
    const stamp = (phase) => `[Console]::Error.WriteLine('OWNERSHIP_PHASE ${phase} ' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())`;
    const instrumented = [stamp('process-entry')];
    for (const line of lines) {
      if (line.startsWith('Import-Module ')) {
        const name = line.slice('Import-Module '.length);
        instrumented.push(stamp(`${name}-begin`), line, stamp(`${name}-end`));
      } else if (line.startsWith('$task = ')) {
        instrumented.push(stamp('task-read-begin'), line, stamp('task-read-end'));
      } else if (line.startsWith('$actions = ')) {
        instrumented.push(stamp('action-extraction-begin'), line, stamp('action-extraction-end'));
      } else if (line.startsWith('$principal = ')) {
        instrumented.push(stamp('principal-extraction-begin'), line, stamp('principal-extraction-end'));
      } else if (line.startsWith('$principalSid = ')) {
        instrumented.push(stamp('principal-sid-begin'), line, stamp('principal-sid-end'));
      } else if (line.startsWith('if ($principalSid -notmatch ')) {
        instrumented.push(stamp('principal-translation-begin'), line, stamp('principal-translation-end'));
      } else if (line.startsWith('ConvertTo-Json ')) {
        instrumented.push(stamp('json-result-begin'), line, stamp('json-result-end'));
      } else instrumented.push(line);
    }
    instrumented.push(stamp('script-end'));
    measured = [...args];
    measured[at + 1] = Buffer.from(instrumented.join('\n'), 'utf16le').toString('base64');
  }
  const result = originalSpawn.call(this, file, measured, options);
  const ended = performance.timeOrigin + performance.now();
  const phases = [];
  if (typeof result.stderr === 'string') {
    result.stderr = result.stderr.replace(/^OWNERSHIP_PHASE (\S+) (\d+)\r?\n/gm, (_line, phase, at) => {
      phases.push({ phase, at: Number(at) });
      return '';
    });
  }
  emit({ kind: 'native-end', file, started, ended, durationMs: ended - started, status: result.status, error: result.error?.code, phases });
  return result;
};
const OriginalWorker = threads.Worker;
threads.Worker = class extends OriginalWorker {
  constructor(script, options) {
    emit({ kind: 'worker-start' });
    if (options?.eval !== true || typeof script !== 'string') throw new Error('Expected the shipped eval ownership worker');
    super(`import(${JSON.stringify(import.meta.url)}).then(() => { ${script}\n });`, { ...options, execArgv: [] });
    this.once('online', () => emit({ kind: 'worker-online' }));
    this.once('exit', (code) => emit({ kind: 'worker-exit', code }));
  }
};
syncBuiltinESMExports();
