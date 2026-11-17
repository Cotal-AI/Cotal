/** Real prepare expiry during teardown cannot prevent an independent host refusal from returning. */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { connect as connectSocket, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import {
  commitSiblingIssuance, createSpaceAuth, credentialIdOf, credsClaims, epAuthBucket,
  mintCreds, mintLifecycleUid, newIdentity, remoteManagerActors, serverConfig,
  serveIssuanceGateKv, setupSpaceStreams, standaloneConnectOpts, isReachable,
} from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, createSuite, freePort, killAndAwaitExit, teardownOnSignal, withDeadline } from "@cotal-ai/smoke-kit";
import { registerRemoteManagerAuthority } from "../dist/index.js";

const suite = createSuite();
const root = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}registration-close-`));
for (const name of ["home", "config", "runtime", "cotal"]) mkdirSync(join(root, name), { mode: 0o700 });
process.env.HOME = join(root, "home");
process.env.XDG_CONFIG_HOME = join(root, "config");
process.env.XDG_RUNTIME_DIR = join(root, "runtime");
process.env.COTAL_HOME = join(root, "cotal");
const space = `regclose${mintLifecycleUid().slice(0, 8)}`;
const port = await freePort();
const server = `nats://127.0.0.1:${port}`;
const auth = await createSpaceAuth(space);
const config = join(root, "server.conf");
writeFileSync(config, serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: join(root, "js") }));
const broker = spawn("nats-server", ["-c", config], { stdio: "ignore" });
const release = teardownOnSignal(broker, root);
const sockets = new Set<Socket>();
let holdReplies = false;
let heldPongs = 0;
let relayConnections = 0;
let expirySeen = false;
const relay = createServer(client => {
  relayConnections++;
  const upstream = connectSocket(port, "127.0.0.1");
  for (const socket of [client, upstream]) {
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.on("close", () => { sockets.delete(socket); });
  }
  client.pipe(upstream);
  upstream.on("data", (bytes: Buffer) => {
    if (!holdReplies) { client.write(bytes); return; }
    // During teardown no application response remains. Suppress only broker PONG frames so
    // subscription drain overlaps actual JWT expiry, while forwarding the broker expiry error.
    const text = bytes.toString("utf8");
    heldPongs += text.split("PONG\r\n").length - 1;
    expirySeen ||= /authentication expired/i.test(text);
    client.write(text.replaceAll("PONG\r\n", ""));
  });
  upstream.on("end", () => client.end());
  upstream.on("close", () => client.destroy());
  client.on("close", () => upstream.destroy());
});
const owner = `u_${"a".repeat(26)}`;
const instanceId = mintLifecycleUid();
const actors = remoteManagerActors(instanceId);
const executor = newIdentity();
const executorCreds = (ttl: number) => mintCreds(auth, executor, "remote-manager", {
  principal: { owner, actor: actors.executor }, remoteManager: { instanceId, owner, actor: actors.executor }, expiresInSeconds: ttl,
});
let observer: Awaited<ReturnType<typeof connect>> | undefined;
try {
  await awaitBrokerReady(() => isReachable(server), { servers: server, attempts: 50, delayMs: 100 });
  await setupSpaceStreams({ servers: server, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  observer = await connect({ servers: server, ...standaloneConnectOpts({ creds: await executorCreds(120), tls: false }), maxReconnectAttempts: 0 });
  const authKv = await new Kvm(observer).open(epAuthBucket(space));
  const gate = serveIssuanceGateKv(authKv, space, { endpoint: "manager", instanceId });
  const base = { space, server, owner, instanceId, serveActor: actors.serve, tlsRequired: false };
  const initial = await registerRemoteManagerAuthority({ ...base, prepareCreds: await executorCreds(120), evict: async holders => holders.map(() => true) });
  suite.check("positive control: ordinary public registration closes its executor and returns", initial.processEpoch === 0);
  const sibling = newIdentity();
  const creds = await mintCreds(auth, sibling, "goal-writer", { principal: { owner, actor: actors.goalWriter }, goalWriter: { endpoint: "manager" } });
  const observed = (await gate.observe())!;
  await commitSiblingIssuance(gate, observed, {
    credentialId: credentialIdOf(creds), credentialKey: sibling.id,
    holderPrincipal: `${owner}.${actors.goalWriter}`, endpoint: "manager", lifecycleUid: instanceId,
    sourceChain: ["root"], state: "active", exp: credsClaims(creds).exp,
    generation: observed.generation, processEpoch: observed.processEpoch,
    registrationRevision: observed.registrationRevision, nameAuthorityRevision: observed.nameAuthorityRevision,
  });
  await new Promise<void>(resolve => relay.listen(0, "127.0.0.1", resolve));
  const address = relay.address();
  if (!address || typeof address === "string") throw new Error("relay has no TCP address");
  const short = await executorCreds(5);
  const expiry = credsClaims(short).exp!;
  const refusal = new Error("independent host refusal at prepare expiry");
  let evictions = 0, refreshes = 0;
  const started = Date.now();
  const outcome = await withDeadline(registerRemoteManagerAuthority({ ...base,
    server: `nats://127.0.0.1:${address.port}`, prepareCreds: short,
    refreshPrepareCreds: async () => { refreshes++; return executorCreds(120); },
    evict: async () => {
      evictions++;
      await new Promise(resolve => setTimeout(resolve, Math.max(0, expiry * 1000 - Date.now() - 300)));
      holdReplies = true;
      throw refusal;
    },
  }).then(() => ({ error: undefined as unknown }), error => ({ error })), 10_000, "public registration refusal teardown");
  suite.check("host refusal returns within the bounded window even if teardown cannot flush",
    outcome?.error === refusal, { returned: outcome !== undefined, elapsedMs: Date.now() - started, heldPongs, expirySeen });
  suite.check("no independent maintenance retry or expiry reconnect occurs", evictions === 1 && refreshes === 0 && relayConnections === 1,
    { evictions, refreshes, relayConnections });
  const finalGate = (await gate.observe())!;
  suite.check("refusal preserves the frozen gate and original process epoch", finalGate.state === "frozen" && finalGate.processEpoch === initial.processEpoch);
} finally {
  for (const socket of sockets) socket.destroy();
  if (relay.listening) await new Promise<void>(resolve => relay.close(() => resolve()));
  await observer?.close();
  await killAndAwaitExit(broker);
  release();
}
suite.finish();
