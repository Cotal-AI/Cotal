/** Kill the shipped daemon while the app's sign-in waits on it, and read what the app is told. */
import strictAssert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { skipSuite } from "@cotal-ai/smoke-kit";
import { countedAssert, emitSentinel } from "./sentinel.mjs";

const counted = countedAssert(strictAssert);
const assert: typeof strictAssert = counted.assert as typeof strictAssert;
if (process.platform !== "linux") skipSuite("daemon-desktop-lost: Linux process control only; the bridge's mapping is the same on every platform");
const root = mkdtempSync(join(tmpdir(), "dlost-"));
const home = join(root, "home"), machine = join(root, "machine"), runtime = join(root, "rt");
for (const path of [home, runtime, machine, join(root, "cotal")]) mkdirSync(path, { mode: 0o700 });
const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, TMPDIR: root, XDG_CONFIG_HOME: join(root, "config"), XDG_RUNTIME_DIR: runtime, COTAL_HOME: join(root, "cotal"), DO_NOT_TRACK: "1" };
const cli = resolve("bin/dist/cotal.js");
let deviceCodes = 0;
// A loopback IdP that issues one device code and keeps the sign-in pending.
const idpServer = createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/api/auth/device/code") {
    deviceCodes++;
    res.end(JSON.stringify({ device_code: "lost-device-secret", user_code: "LOST", verification_uri: "http://127.0.0.1/verify", verification_uri_complete: "http://127.0.0.1/verify?code=LOST", expires_in: 60, interval: 1 }));
  } else if (req.url === "/api/auth/device/token") { res.writeHead(400); res.end(JSON.stringify({ error: "authorization_pending" })); }
  else { res.writeHead(404); res.end("{}"); }
});
await new Promise<void>(done => idpServer.listen(0, "127.0.0.1", done));
const idp = `http://127.0.0.1:${(idpServer.address() as { port: number }).port}/api/auth`;
const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;
const daemon = spawn(process.execPath, [cli, "daemon", "serve", "--daemon-home", machine], { env, cwd: home, stdio: ["ignore", "ignore", "ignore"] });
let bridge: ChildProcess | undefined;
try {
  const frames: Record<string, any>[] = [];
  for (const end = Date.now() + 20_000; ;) {
    const status = spawn(process.execPath, [cli, "daemon", "status", "--json", "--daemon-home", machine], { env, cwd: home, stdio: ["ignore", "pipe", "ignore"] });
    let statusOut = "";
    status.stdout!.on("data", chunk => { statusOut += chunk; });
    if (await new Promise(done => status.once("close", done)) === 0 && statusOut.includes('"outcome":"ok"')) break;
    assert.ok(Date.now() < end, "the daemon answered within 20 s");
    await new Promise(done => setTimeout(done, 200));
  }
  bridge = spawn(process.execPath, [cli, "daemon", "desktop", "--daemon-home", machine], { env, cwd: home, stdio: ["pipe", "pipe", "ignore"] });
  let buffer = "";
  const closed = new Promise<number | null>(done => bridge!.once("close", done));
  const prompted = new Promise<void>((done, fail) => {
    bridge!.stdout!.on("data", chunk => {
      buffer += chunk;
      for (let nl; (nl = buffer.indexOf("\n")) !== -1; buffer = buffer.slice(nl + 1)) {
        const frame = JSON.parse(buffer.slice(0, nl));
        frames.push(frame);
        if (frame.event === "login-prompt") done();
        if (frame.event === "result") fail(new Error(`sign-in ended before its prompt: ${JSON.stringify(frame)}`));
      }
    });
  });
  bridge.stdin!.end(`${JSON.stringify({ op: "login", idp })}\n`);
  await Promise.race([prompted, new Promise((_, fail) => setTimeout(() => fail(new Error("no sign-in prompt within 20 s")), 20_000))]);
  assert.equal(deviceCodes, 1, "the daemon asked the loopback IdP for one device code");
  daemon.kill("SIGKILL");
  assert.equal(await closed, 0, "the bridge reports the lost daemon as a result frame and exits cleanly");
  const results = frames.filter(frame => frame.event === "result");
  assert.equal(results.length, 1, "exactly one result frame");
  const [result] = results;
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "DAEMON_LOST", `lost daemon code: ${JSON.stringify(result.error)}`);
  assert.equal(result.error.message, "The background service stopped before this could finish, so it did not complete. Try again when the service is running.");
  assert.ok(!JSON.stringify(result).includes("cotal daemon"), "the app is never pointed at a CLI it does not have");
  emitSentinel({ passed: counted.cells(), failed: 0 });
} finally {
  if (bridge && !exited(bridge)) bridge.kill("SIGKILL");
  if (!exited(daemon)) { const done = new Promise(r => daemon.once("exit", r)); daemon.kill("SIGKILL"); await done; }
  idpServer.closeAllConnections();
  await new Promise<void>(done => idpServer.close(() => done()));
}
