/** Terminate an owned worker while its native notification barrier is pending. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { requestProcessStorageRemoval, processStartToken } from '../dist/index.js';
if (!isMainThread) {
  const pending = requestProcessStorageRemoval('owned-worker');
  parentPort.postMessage('queued');
  await pending.catch(() => undefined);
} else {
  const root = process.argv[2];
  const worker = new Worker(new URL(import.meta.url));
  const [message] = await once(worker, 'message', { signal: AbortSignal.timeout(5000) });
  assert.equal(message, 'queued');
  const start = performance.now();
  const code = await worker.terminate();
  const elapsedMs = performance.now() - start;
  assert.equal(code, 1); assert.ok(elapsedMs < 12000);
  writeFileSync(join(root, 'result.json'), JSON.stringify({ owner: { pid: process.pid, birth: processStartToken(process.pid) }, code, elapsedMs, checks: 3 }, null, 2), { flag: 'wx', mode: 0o600 });
  console.log('3 worker termination checks passed');
}
