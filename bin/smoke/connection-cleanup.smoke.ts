/**
 * REAL JWT broker. Connection teardown through the core helper and the built channel CLI.
 * A relay withholds teardown UNSUB/PING bytes to exercise credential expiry and a silent peer.
 * Run: pnpm smoke:connection-cleanup
 */
import nodeAssert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import {
  channelBucket, createSpaceAuth, drainAndClose, mintCreds, newIdentity,
  seedChannelRegistry, serverConfig, setupSpaceStreams, standaloneConnectOpts,
} from "@cotal-ai/core";
import {
  countedAssert, emitSentinel, freePort, killAndAwaitExit, SMOKE_BROKER_TOKEN, teardownOnSignal,
} from "@cotal-ai/smoke-kit";

const counted = countedAssert(nodeAssert);
const assert: typeof nodeAssert = counted.assert;
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const space = "cleanup";
const port = await freePort();
const servers = `nats://127.0.0.1:${port}`;
const auth = await createSpaceAuth(space);
const conf = join(dir, "server.conf");
writeFileSync(conf, serverConfig(auth, [auth], { port, storeDir: join(dir, "store"), transport: { kind: "plaintext" } }));
const broker = spawn("nats-server", ["-c", conf], { stdio: "ignore" });
const release = teardownOnSignal(broker, dir);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function relay(mode: "forward" | "withhold", channelReadOnly = false) {
  const sockets = new Set<Socket>();
  let withheld = false;
  let expired = false;
  let metadata = false;
  let directGet = false;
  let active = 0;
  const server = createServer((client) => {
    const upstream = createConnection({ host: "127.0.0.1", port });
    sockets.add(client);
    sockets.add(upstream);
    active++;
    let holding = false;
    let sawDirectGet = false;
    let received = "";
    let pending = "";
    client.on("data", (bytes: Buffer) => {
      // Only inspect complete protocol lines, not arbitrary TCP chunk boundaries.
      pending += bytes.toString("latin1");
      for (;;) {
        const end = pending.indexOf("\r\n");
        if (end < 0) break;
        const line = pending.slice(0, end + 2);
        pending = pending.slice(end + 2);
        if (line.includes(`$JS.API.DIRECT.GET.KV_${channelBucket(space)}`)) sawDirectGet = directGet = true;
        if (mode === "withhold" && line.startsWith("UNSUB ") && (!channelReadOnly || (sawDirectGet && metadata))) holding = withheld = true;
        if (!holding) upstream.write(Buffer.from(line, "latin1"));
      }
    });
    upstream.on("data", (bytes: Buffer) => {
      received = (received + bytes.toString("utf8")).slice(-4_096);
      if (sawDirectGet && received.includes("General coordination")) metadata = true;
      if (received.includes("User Authentication Expired")) expired = true;
      client.write(bytes);
    });
    upstream.on("end", () => client.end());
    client.on("end", () => upstream.end());
    client.on("error", () => {});
    upstream.on("error", () => {});
    client.on("close", () => { active--; sockets.delete(client); upstream.destroy(); });
    upstream.on("close", () => { sockets.delete(upstream); client.end(); });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    servers: `nats://127.0.0.1:${address.port}`,
    state: () => ({ withheld, expired, metadata, directGet, active }),
    async stop() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

async function until(check: () => boolean, ms = 2_000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await sleep(10);
  assert.ok(check(), "condition did not settle before deadline");
}

try {
  const provisioner = await mintCreds(auth, newIdentity(), "provisioner");
  const writer = await mintCreds(auth, newIdentity(), "channel-writer");
  let ready = false;
  for (let attempt = 0; attempt < 100 && !ready; attempt++) {
    try {
      const nc = await connect({ servers, authenticator: credsAuthenticator(new TextEncoder().encode(provisioner)), timeout: 200 });
      await nc.close();
      ready = true;
    } catch { await sleep(50); }
  }
  assert.ok(ready, "isolated broker must be ready");
  await setupSpaceStreams({ servers, space, creds: provisioner });
  await seedChannelRegistry({ servers, space, creds: writer, file: { channels: { general: { description: "General coordination" } } } });

  for (const mode of ["forward", "withhold"] as const) {
    const link = await relay(mode);
    const creds = await mintCreds(auth, newIdentity(), "operator", { expiresInSeconds: mode === "withhold" ? 2 : 300 });
    const nc = await connect({ servers: link.servers, ...standaloneConnectOpts({ creds, tls: false }), maxReconnectAttempts: 0 });
    const subject = `${String(standaloneConnectOpts({ creds, tls: false }).inboxPrefix)}.probe`;
    nc.subscribe(subject, { callback: (error) => { assert.equal(error, null); } });
    await nc.flush();
    try {
      const started = Date.now();
      await drainAndClose(nc, 5_000);
      assert.ok(nc.isClosed());
      await nc.closed();
      await until(() => link.state().active === 0);
      assert.equal(link.state().withheld, mode === "withhold");
      assert.equal(link.state().expired, mode === "withhold");
      assert.ok(Date.now() - started < 4_500, "terminal closure must win before the five-second grace");
      console.log(`core ${mode}: closed with no remaining relay connection`);
    } finally { await nc.close(); await link.stop(); }
  }

  // A long-lived credential keeps the socket open, so only the grace period can end this drain.
  {
    const link = await relay("withhold");
    const creds = await mintCreds(auth, newIdentity(), "operator");
    const nc = await connect({ servers: link.servers, ...standaloneConnectOpts({ creds, tls: false }), maxReconnectAttempts: 0 });
    nc.subscribe(`${String(standaloneConnectOpts({ creds, tls: false }).inboxPrefix)}.probe`, { callback: () => {} });
    await nc.flush();
    try {
      const start = Date.now();
      await drainAndClose(nc, 100);
      assert.ok(Date.now() - start >= 90 && Date.now() - start < 2_000);
      await until(() => link.state().active === 0);
      assert.equal(link.state().withheld, true);
      assert.equal(link.state().expired, false);
      await drainAndClose(nc); // already closed is safe
      console.log("silent peer: grace period closes the live connection");
    } finally { await nc.close(); await link.stop(); }
  }

  for (const mode of ["forward", "withhold"] as const) {
    const link = await relay(mode, true);
    const creds = await mintCreds(auth, newIdentity(), "operator", { expiresInSeconds: mode === "withhold" ? 3 : 300 });
    const credsPath = join(dir, `cli-${mode}.creds`);
    writeFileSync(credsPath, creds, { mode: 0o600 });
    const child = spawn(process.execPath, [fileURLToPath(new URL("../dist/cotal.js", import.meta.url)), "channel", "--space", space, "--server", link.servers, "--creds", credsPath, "--json"], {
      cwd: dir,
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_"))), HOME: join(dir, "home"), XDG_CONFIG_HOME: join(dir, "config"), XDG_RUNTIME_DIR: join(dir, "runtime"), COTAL_HOME: join(dir, "cotal"), COTAL_TELEMETRY: "off" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (bytes: Buffer) => { out += bytes.toString(); });
    child.stderr.on("data", (bytes: Buffer) => { err += bytes.toString(); });
    const exited = once(child, "close");
    const watchdog = setTimeout(() => child.kill("SIGKILL"), 10_000);
    try {
      const [code, signal] = await exited;
      assert.equal(signal, null, err);
      assert.equal(code, 0, err);
      const result = JSON.parse(out);
      assert.equal(result.outcome, "ok");
      assert.equal(result.result.registry.channels.general.description, "General coordination");
      await until(() => link.state().active === 0);
      assert.equal(link.state().withheld, mode === "withhold");
      assert.equal(link.state().directGet, true);
      assert.equal(link.state().metadata, true);
      console.log(`CLI ${mode}: exit 0 with channel metadata and no remaining connection`);
    } finally {
      clearTimeout(watchdog);
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
      await link.stop();
    }
  }
} finally {
  await killAndAwaitExit(broker);
  release();
  // Retain the private store and logs for inspection by the caller.
}
console.log("connection cleanup smoke passed");
emitSentinel({ passed: counted.cells(), failed: 0 });
