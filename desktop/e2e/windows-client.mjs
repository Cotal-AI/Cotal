import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";

// Read-only companion to the actual app's first install. Import the same bundled client
// to retain errors that the renderer deliberately receives only as a sanitized refusal.
const [runtime, home] = process.argv.slice(2);
const { daemonPathsFor } = await import(pathToFileURL(join(runtime, "dist/daemon/endpoint.js")));
const { queryDaemon } = await import(pathToFileURL(join(runtime, "dist/daemon/client.js")));
const paths = daemonPathsFor(home);
const deadline = Date.now() + 120_000;
while (Date.now() < deadline) {
  const started = Date.now();
  const at = new Date(started).toISOString();
  try {
    const reply = await queryDaemon({ paths });
    console.log(JSON.stringify({ at, completedAt: new Date().toISOString(), elapsedMs: Date.now() - started, ok: reply.ok, state: reply.result?.state, pid: reply.result?.pid }));
  } catch (error) {
    console.log(JSON.stringify({ at, completedAt: new Date().toISOString(), elapsedMs: Date.now() - started, error: { name: error.name, code: error.code, message: error.message, stack: error.stack } }));
  }
  await delay(500);
}
