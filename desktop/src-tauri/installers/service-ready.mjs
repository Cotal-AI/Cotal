import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const [root, version, evidence, setupAttempt] = process.argv.slice(2);
if (process.platform !== 'win32' || !root || !/^\d+\.\d+\.\d+$/.test(version ?? '') || !evidence || !/^[a-f0-9-]{36}$/.test(setupAttempt ?? '')) throw new Error('Unsupported setup readiness invocation.');
process.argv = [process.execPath, join(root, 'runtime', 'dist', 'cotal.js')];
process.execArgv = [];
const get = name => import(pathToFileURL(join(root, 'runtime', 'dist', 'daemon', `${name}.js`)).href);
const [endpoint, client, lifetime] = await Promise.all(['endpoint', 'client', 'lifetime'].map(get));
const deadline = Date.now() + 60_000;
let ready = false;
try {
  do {
    try {
      const reply = await client.queryDaemon({ paths: endpoint.daemonPaths(), timeoutMs: 1000 });
      if (reply.ok && reply.result.version === version && reply.result.state === 'ready') { ready = true; break; }
    } catch (error) {
      if (!(error instanceof endpoint.EndpointRefusal && error.code === 'NOT_RUNNING')) throw error;
    }
    await delay(500);
  } while (Date.now() < deadline);
  process.stdout.write(JSON.stringify({ ready }));
} finally {
  // The parent waits for process exit, which releases these mapped native files.
  try {
    writeFileSync(evidence, JSON.stringify({ setupAttempt, pid: process.pid, birth: lifetime.processBirth(process.pid), ready, modules: process.report.getReport().sharedObjects.filter(file => file.toLowerCase().startsWith(join(root, 'runtime').toLowerCase() + '\\')) }));
  } catch { /* Evidence failure must not replace the readiness or rollback decision. */ }
}
