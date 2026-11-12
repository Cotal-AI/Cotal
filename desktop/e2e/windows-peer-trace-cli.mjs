import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// This process is deliberately not a node:test worker. Its CLI child's stdout is
// the real command's stream, not the runner's serialized test-result transport.
const [root, cliPath] = process.argv.slice(2);
const dirs = { HOME: join(root, "home"), USERPROFILE: join(root, "home"), COTAL_HOME: join(root, "cotal"),
  XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
  XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"), XDG_RUNTIME_DIR: join(root, "r"),
  APPDATA: join(root, "roaming"), LOCALAPPDATA: join(root, "local") };
for (const path of Object.values(dirs)) fs.mkdirSync(path, { recursive: true, mode: 0o700 });
for (const key of Object.keys(process.env)) {
  if (key.toUpperCase().startsWith("COTAL_") || ["NODE_OPTIONS", "NODE_PATH", "NODE_TEST_CONTEXT"].includes(key)) delete process.env[key];
}
Object.assign(process.env, dirs, { DO_NOT_TRACK: "1" });
// Product imports happen only after the private home and runtime are selected.
const { daemonPaths } = await import(pathToFileURL(join(dirname(cliPath), "daemon/endpoint.js")).href);
const paths = daemonPaths();
fs.mkdirSync(paths.state, { recursive: true, mode: 0o700 });
if (paths.dir) fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
const raw = JSON.stringify({ v: 1, pid: process.pid, start: "deliberately-not-the-server-birth", startedAt: new Date().toISOString() }) + "\r\n";
fs.writeFileSync(paths.lock, raw, { mode: 0o600 });
const output = join(root, "cli-receipts.jsonl"), loader = join(root, "preload.mjs");
const trace = new URL("./windows-peer-trace.mjs", import.meta.url).href;
const context = { cliPath, pipe: paths.socket, lock: paths.lock, output };
fs.writeFileSync(loader, process.platform === "win32"
  ? `import { installWindowsPeerTraceFromContext } from ${JSON.stringify(trace)}; await installWindowsPeerTraceFromContext(${JSON.stringify(context)});\n`
  // Linux has no pipeConnect. This fixture-only object enables the same stdout/read
  // observer without replacing or claiming to exercise any native product function.
  : `import fs from 'node:fs'; import { installWindowsPeerTrace } from ${JSON.stringify(trace)}; installWindowsPeerTrace({native:{pipeConnect(){throw new Error('unused fixture pipe');}},pipePath:${JSON.stringify(paths.socket)},lockPath:${JSON.stringify(paths.lock)},record:r=>fs.appendFileSync(${JSON.stringify(output)},JSON.stringify(r)+'\\n')});\n`);
let connections = 0, bytes = 0;
const sockets = new Set(), closed = [];
const server = createServer(socket => {
  connections++;
  sockets.add(socket);
  closed.push(new Promise(resolve => socket.once("close", resolve)));
  socket.on("data", chunk => { bytes += chunk.length; });
  socket.once("close", () => sockets.delete(socket));
  socket.on("error", () => {});
});
try {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(paths.socket, resolve); });
  if (paths.dir) fs.chmodSync(paths.socket, 0o600);
  const child = spawn(process.execPath, ["--import", pathToFileURL(loader).href, cliPath, "daemon", "desktop"], {
    env: process.env, stdio: ["pipe", "pipe", "pipe"], timeout: 20000,
  });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  const result = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  child.stdin.end('{"op":"status"}\n');
  assert.deepEqual(await result, { code: 0, signal: null }, stderr);
  await Promise.all(closed);
  const frame = JSON.parse(stdout);
  assert.equal(frame.event, "result");
  assert.equal(frame.ok, false);
  assert.equal(frame.error.code, "PEER_NOT_LOCK_OWNER", stdout);
  assert.equal(connections, 1, "the actual CLI opens only one connection");
  assert.equal(bytes, 0, "the squatter receives no request bytes");
  const found = fs.readFileSync(output, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(found.map(r => r.phase), process.platform === "win32"
    ? ["peer-trace-installed", "pipe-connected", "lock-read", "client-refusal"] : ["lock-read", "client-refusal"]);
  const read = found.find(r => r.phase === "lock-read"), refusal = found.at(-1);
  assert.equal(read.read, 1, "the client reads the lock once");
  assert.equal(read.bytesBase64, Buffer.from(raw).toString("base64"));
  assert.equal(refusal.afterRead, read.read);
  if (process.platform === "win32") {
    const connected = found.find(r => r.phase === "pipe-connected");
    assert.equal(connected.attempt, 1);
    assert.equal(connected.peer.pid, process.pid);
    assert.equal(read.afterAttempt, connected.attempt);
    assert.equal(refusal.afterAttempt, connected.attempt);
  }
  process.stdout.write(JSON.stringify({ phases: found.map(r => r.phase), connections, lockReads: read.read, requestBytes: bytes, cliRefusal: frame.error.code }) + "\n");
} finally {
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => server.close(resolve));
}
