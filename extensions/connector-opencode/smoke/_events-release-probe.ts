/**
 * Subprocess probe for the opencode event-release smoke (events-release.smoke.ts). Never run
 * standalone.
 *
 * A SEPARATE PROCESS BECAUSE THE CLAIM IS ABOUT PROCESSES: `dispose` ends the process it runs in,
 * so only a parent can see that it did and what it left on disk.
 *
 * The probe boots the real plugin against a tiny fake OpenCode HTTP server, drives one event so the
 * emitter binds and takes the lock, and then disposes.
 */
import { once } from "node:events";
import { createServer } from "node:http";
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootPlugin } from "./_boot-plugin.js";

const auth = `Basic ${Buffer.from("opencode:test-secret").toString("base64")}`;
const READY = process.env.REL_READY!;
const DISPOSE = process.env.REL_DISPOSE!;
const SESSION = process.env.REL_SESSION ?? "ses_rel";
const WS = process.env.COTAL_WORKSPACE_ROOT!;

const oc = createServer((req, res) => {
  if (req.headers.authorization !== auth) return void res.writeHead(401).end();
  req.setEncoding("utf8");
  req.on("data", () => {});
  req.on("end", () => {
    if (req.method === "POST" && req.url === "/session")
      return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: SESSION }));
    if (req.method === "GET" && /^\/session\/[^/]+\/message$/.test(req.url ?? ""))
      return void res.writeHead(200, { "content-type": "application/json" }).end("[]");
    if (req.method === "POST" && req.url?.endsWith("/prompt_async")) return void res.writeHead(204).end();
    res.writeHead(404).end();
  });
});
oc.listen(0, "127.0.0.1");
await once(oc, "listening");
process.env.COTAL_OPENCODE_SERVER_URL = `http://127.0.0.1:${(oc.address() as { port: number }).port}`;
process.env.OPENCODE_SERVER_USERNAME = "opencode";
process.env.OPENCODE_SERVER_PASSWORD = "test-secret";

/** Every `.lock` under the workspace root. FOUND rather than computed: the layout hashes each path
 *  component, and a probe that recomputed those hashes would be a second copy of the layout that can
 *  disagree with the one under test. */
const locks = (root: string): string[] => {
  const out: string[] = [];
  const walk = (d: string): void => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (e === ".lock") out.push(p);
    }
  };
  walk(root);
  return out;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms).unref?.());
const hooks = await bootPlugin();
const fire = (event: unknown): Promise<void> => (hooks as unknown as { event: (a: unknown) => Promise<void> }).event({ event });

await sleep(1_000);
// Binds the holder and starts the emitter, which is what takes the lock. A create alone does not:
// the start is lazy and runs on the first event that names a session.
await fire({ type: "session.created", properties: { info: { id: SESSION } } });
await fire({ type: "message.part.updated", properties: { part: { sessionID: SESSION } } });
for (let i = 0; i < 100 && locks(WS).length === 0; i++) await sleep(200);
writeFileSync(READY, `${process.pid} :: ${JSON.stringify(locks(WS))}\n`);

while (!existsSync(DISPOSE)) await sleep(50);
await (hooks as unknown as { dispose?: () => Promise<void> }).dispose?.();
// Reached only when `dispose` returned instead of ending the process. Held up, so the exit code the
// parent grades can only have come from the dispose.
setInterval(() => undefined, 1_000);
setTimeout(() => process.exit(4), 120_000);
