/** Kill the shipped daemon after its persisted UUID reaches PUT, before the response. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { saveIdpSession } from "@cotal-ai/auth";
const root = mkdtempSync(join(tmpdir(), "dacct-"));
const home = join(root, "home"), machine = join(root, "machine"), runtime = join(root, "rt");
for (const path of [home, runtime]) mkdirSync(path, { mode: 0o700 });
const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(root, "config"), XDG_RUNTIME_DIR: runtime, COTAL_HOME: join(root, "cotal") };
for (const key of Object.keys(env)) if (key.startsWith("COTAL_") && !["COTAL_HOME", "COTAL_SKIP_CONNECTOR_SEED", "COTAL_TELEMETRY"].includes(key)) delete env[key];
const ids: string[] = [];
let first = true;
const fixture = createServer((req, res) => {
  const id = req.url?.split("/")[4];
  if (req.method !== "PUT" || !id) { res.writeHead(503); res.end(); return; }
  const files = readdirSync(join(machine, "daemon", "accounts"), { recursive: true }).map(String).filter(path => path.endsWith("computer.json"));
  assert.ok(files.some(path => JSON.parse(readFileSync(join(machine, "daemon", "accounts", path), "utf8")).machineId === id));
  ids.push(id);
  if (first) return;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ v: 1, machine: { id, lastSeenAt: new Date().toISOString() } }));
});
await new Promise<void>(resolve => fixture.listen(0, "127.0.0.1", resolve));
const idp = `http://127.0.0.1:${(fixture.address() as { port: number }).port}/api/auth`;
saveIdpSession(machine, idp, { token: "crash-fixture", sub: "owner", expiresAt: Date.now() / 1000 + 3600 });
const start = () => {
  const child = spawn(process.execPath, [resolve("bin/dist/cotal.js"), "daemon", "serve", "--daemon-home", machine], { env, cwd: home, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout!.on("data", chunk => process.stdout.write(chunk));
  child.stderr!.on("data", chunk => process.stderr.write(chunk));
  child.on("error", error => { throw error; });
  return child;
};
const exit = async (child: ChildProcess, signal: NodeJS.Signals) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const done = new Promise<void>(resolve => child.once("exit", () => resolve()));
  child.kill(signal); await done;
};
const until = async (test: () => boolean) => {
  const end = Date.now() + 15_000;
  while (!test() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(test(), "daemon reached metadata PUT");
};
let child = start();
try {
  await until(() => ids.length === 1);
  await exit(child, "SIGKILL");
  first = false;
  fixture.closeAllConnections();
  child = start();
  await until(() => ids.length >= 2);
  assert.equal(ids[0], ids[1]);
  console.log(`ok crash before PUT response reuses persisted UUID; fixture ${root}`);
} finally {
  await exit(child, "SIGTERM");
  fixture.closeAllConnections();
  await new Promise<void>(resolve => fixture.close(() => resolve()));
}
