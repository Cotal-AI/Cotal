/** Real broker teardown through the published helper, channel CLI and Manager registration. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "@nats-io/transport-node";
import {
  chatSubject, closeConnection, createSpaceAuth, DEV_OWNER, isReachable, mintCreds, mintLifecycleUid, newIdentity,
  remoteManagerActors, seedChannelRegistry, serverConfig, setupSpaceStreams, standaloneConnectOpts,
  type SpaceAuth,
} from "@cotal-ai/core";
import { registerRemoteManagerAuthority } from "@cotal-ai/manager";
import {
  SMOKE_BROKER_TOKEN, awaitBrokerReady, freePort, killAndAwaitExit, teardownOnSignal, withDeadline,
} from "@cotal-ai/smoke-kit";

const root = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const space = "closeconnection";
const port = await freePort();
const servers = `nats://127.0.0.1:${port}`;
const auth = await createSpaceAuth(space);
const config = join(root, "server.conf");
writeFileSync(config, serverConfig(auth, [auth], { port, storeDir: join(root, "store"), transport: { kind: "plaintext" } }), { mode: 0o600 });
const broker = spawn("nats-server", ["-c", config], { stdio: "ignore" });
const release = teardownOnSignal(broker, root);
const cli = fileURLToPath(new URL("../dist/cotal.js", import.meta.url));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_")));
for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR", "COTAL_HOME"]) {
  const dir = join(root, key);
  mkdirSync(dir, { mode: 0o700 });
  env[key] = dir;
}
env.COTAL_TELEMETRY = "off";

async function bounded<T>(work: Promise<T>, label: string): Promise<T> {
  const result = await withDeadline(work.then((value) => ({ value })), 8_000, label);
  assert.ok(result, `${label} must settle`);
  return result.value;
}

/** Hold the teardown round trip, without changing the preceding application requests or replies. */
async function relay(hold: boolean, needsMetadata = false) {
  const sockets = new Set<Socket>();
  let withheld = false;
  let metadata = false;
  let expired = 0;
  const server = createServer((client) => {
    const upstream = createConnection({ host: "127.0.0.1", port });
    sockets.add(client);
    sockets.add(upstream);
    let holding = false;
    client.on("data", (bytes: Buffer) => {
      if (holding) return;
      const at = bytes.indexOf("UNSUB ");
      if (hold && (!needsMetadata || metadata) && at !== -1) {
        withheld = true;
        holding = true;
        if (at > 0) upstream.write(bytes.subarray(0, at));
      } else upstream.write(bytes);
    });
    upstream.on("data", (bytes: Buffer) => {
      if (bytes.includes("General coordination")) metadata = true;
      if (bytes.includes("User Authentication Expired")) expired++;
      client.write(bytes);
    });
    client.on("end", () => upstream.end());
    upstream.on("end", () => client.end());
    client.on("close", () => { sockets.delete(client); upstream.destroy(); });
    upstream.on("close", () => { sockets.delete(upstream); client.destroy(); });
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    servers: `nats://127.0.0.1:${address.port}`,
    get withheld() { return withheld; },
    get metadata() { return metadata; },
    get expired() { return expired; },
    async empty() {
      for (let n = 0; n < 100 && sockets.size; n++) await sleep(10);
      assert.equal(sockets.size, 0, "teardown must close both relay sockets");
    },
    async stop() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

type Mode = "control" | "expired" | "stalled";
async function freshCreds(auth: SpaceAuth, mode: Mode) {
  // The expiry lands during the default 2-second drain grace, after registration completes.
  if (mode === "expired") await sleep(1_000 - Date.now() % 1_000 + 20);
  return mintCreds(auth, newIdentity(), "operator", { expiresInSeconds: mode === "expired" ? 2 : 300 });
}

async function channelCase(mode: Mode) {
  const link = await relay(mode !== "control", true);
  try {
    const credsPath = join(root, `channel-${mode}.creds`);
    writeFileSync(credsPath, await freshCreds(auth, mode), { mode: 0o600 });
    const child = spawn(process.execPath, [cli, "channel", "--space", space, "--server", link.servers, "--creds", credsPath, "--json"], {
      cwd: root, env, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const timer = setTimeout(() => child.kill("SIGKILL"), 8_000);
    let code;
    try {
      code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
    } finally {
      clearTimeout(timer);
      await killAndAwaitExit(child);
    }
    assert.equal(code, 0, `channel ${mode}: ${stderr}`);
    const output = JSON.parse(stdout);
    assert.equal(output.outcome, "ok");
    assert.equal(output.result.registry.channels.general.description, "General coordination");
    assert.equal(link.metadata, true);
    assert.equal(link.withheld, mode !== "control");
    if (mode === "expired") assert.ok(link.expired > 0, "broker must expire the in-flight drain");
    if (mode === "stalled") assert.equal(link.expired, 0, "grace must close without broker expiry");
    await link.empty();
    console.log(`channel ${mode}: exit ${code}, metadata returned, ${link.expired} broker expirations, no sockets`);
  } finally { await link.stop(); }
}

async function managerCase(mode: Mode) {
  const link = await relay(mode !== "control");
  try {
    const owner = `u_${"d".repeat(26)}`;
    const instanceId = mintLifecycleUid();
    const actors = remoteManagerActors(instanceId);
    if (mode === "expired") await sleep(1_000 - Date.now() % 1_000 + 20);
    const prepareCreds = await mintCreds(auth, newIdentity(), "remote-manager", {
      principal: { owner, actor: actors.executor },
      remoteManager: { instanceId, owner, actor: actors.executor },
      expiresInSeconds: mode === "expired" ? 2 : 300,
    });
    const registration = await bounded(registerRemoteManagerAuthority({
      space, server: link.servers, owner, instanceId, serveActor: actors.serve, prepareCreds,
      tlsRequired: false, evict: async (principals) => principals.map(() => true),
    }), `manager ${mode}`);
    assert.ok(registration.registrationRevision >= 1);
    assert.ok(Number.isSafeInteger(registration.processEpoch) && registration.processEpoch >= 0);
    assert.equal(link.withheld, mode !== "control");
    if (mode === "expired") assert.ok(link.expired > 0, "broker must expire the in-flight drain");
    if (mode === "stalled") assert.equal(link.expired, 0);
    await link.empty();
    console.log(`manager ${mode}: registration returned, ${link.expired} broker expirations, no sockets`);
  } finally { await link.stop(); }
}

try {
  await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 50, delayMs: 100 });
  await setupSpaceStreams({ servers, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  await seedChannelRegistry({ servers, space, creds: await mintCreds(auth, newIdentity(), "channel-writer"), file: { channels: { general: { description: "General coordination" } } } });
  for (const mode of ["control", "expired", "stalled"] as const) {
    await channelCase(mode);
    await managerCase(mode);
  }

  const identity = newIdentity();
  const creds = await mintCreds(auth, identity, "operator");
  const nc = await connect({ servers, ...standaloneConnectOpts({ creds, tls: false }), reconnect: false });
  const reader = await connect({ servers, ...standaloneConnectOpts({ creds: await mintCreds(auth, newIdentity(), "observer"), tls: false }), reconnect: false });
  const subject = chatSubject(space, DEV_OWNER, identity.id, "control");
  const sub = reader.subscribe(subject, { max: 1 });
  await reader.flush();
  const received = (async () => {
    const messages: string[] = [];
    for await (const message of sub) messages.push(message.string());
    return messages;
  })();
  try {
    nc.publish(subject, "buffered");
    await bounded(closeConnection(nc), "healthy drain");
    assert.deepEqual(await bounded(received, "buffered delivery"), ["buffered"]);
    assert.equal(nc.isClosed(), true);
    await bounded(closeConnection(nc), "already closed");
  } finally {
    await nc.close();
    await reader.close();
  }

  const held = await relay(true);
  const conn = await connect({ servers: held.servers, ...standaloneConnectOpts({ creds, tls: false }), reconnect: false });
  try {
    conn.subscribe(`_INBOX_${identity.id}.held`);
    await conn.flush();
    const started = Date.now();
    await bounded(Promise.all([closeConnection(conn, 100), closeConnection(conn, 100)]), "concurrent drain");
    assert.ok(Date.now() - started >= 75, "a second closer must not abort an existing drain early");
    assert.equal(held.withheld, true);
    assert.equal(conn.isClosed(), true);
    await held.empty();
  } finally {
    await conn.close();
    await held.stop();
  }
  for (const grace of [-1, NaN, Infinity, 0.5]) {
    await assert.rejects(closeConnection(nc, grace), /nonnegative safe integer/);
  }
  console.log("connection close: healthy delivery, already closed, concurrent grace and invalid grace passed");
} finally {
  await killAndAwaitExit(broker);
  release();
  // Retain the private fixture for failure diagnosis. All children and sockets have stopped.
}
