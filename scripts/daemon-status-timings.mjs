import { appendFileSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export function isTimedStatus({ platform, nextHopMode, method, followOnAction, argv }) {
  return platform === 'darwin' && nextHopMode === 'candidate' && method === 'self' && followOnAction === 'self'
    && argv.some((arg, index) => arg === 'daemon' && argv[index + 1] === 'status');
}

/** One small, exclusive archive per public invocation, written before spawning. */
export function statusTiming(file, env, label = 'synthetic status') {
  const preload = fileURLToPath(new URL('./daemon-status-timing-preload.cjs', import.meta.url));
  const row = (stage, extra = {}) => JSON.stringify({ stage, at: new Date().toISOString(), monotonicNs: process.hrtime.bigint().toString(), ...extra }) + '\n';
  writeFileSync(file, row('command-start', { label, pid: process.pid }), { flag: 'wx', mode: 0o600 });
  return {
    env: { ...env, COTAL_STATUS_TIMING_FILE: file, NODE_OPTIONS: [env.NODE_OPTIONS, `--require=${JSON.stringify(preload)}`].filter(Boolean).join(' ') },
    finish(result) {
      appendFileSync(file, row('command-exit', { exit: result.exit, signal: result.signal ?? null, timeout: result.timeout ?? result.timedOut ?? false }));
      if (statSync(file).size > 16 * 1024) throw new Error('status timing evidence exceeds bound');
      const events = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const bytes = readFileSync(file);
      return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), ...(events.some(event => event.stage === 'preload-ready') ? {} : { error: 'status timing instrumentation did not become ready (inspect archived command stderr)' }) };
    },
  };
}
