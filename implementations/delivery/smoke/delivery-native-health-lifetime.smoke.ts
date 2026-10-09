/**
 * Delivery daemon native transport health and embedded service lifetime smoke.
 *
 * Exercises the ACTUAL delivery daemon and embedded delivery paths:
 * 1. Counted healthy connection churn: zero additional broker connections over time (no polling).
 * 2. Event-loop lag: short local scheduler burst causes no health dial or false loss.
 * 3. Actual daemon silent packet loss: byte-dropping proxy drops native PINGs; daemon detects
 *    loss within bounded 15s window while sibling context remains ready and serving.
 * 4. Successful and failed credential adoption via delivery-admin rail and injected SecretStore.
 * 5. Context isolation: sibling context remains serving when one context closes or faults.
 * 6. Post-expiry recovery: public broker-verified adoption clears the original health backstop.
 * 7. Broker restart: a raw resident transport reconnects (not a daemon-restart claim).
 * 8. Sustained broker loss: the embedded context becomes unavailable within a bounded window.
 * 9. Owned connections, contexts, proxy, broker and state close before reporting success.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, connect as connectSocket, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { connect, credsAuthenticator, NoRespondersError, RequestError, type NatsConnection } from "@nats-io/transport-node";
import {
  CotalEndpoint, composeSpaceAuth, createBrokerAuth, createSpaceAccountAuth, isReachable, mintCreds,
  mintMembershipObserverCreds, mintLifecycleUid, newIdentity, serverConfig, setupSpaceStreams,
  controlServiceSubject, CONTROL_DELIVERY, DEV_OWNER,
  type SecretStore, type SpaceAuth,
} from "@cotal-ai/core";
import { deliveryCredsKey, membershipObserverCredsKey, membershipRwCredsKey, type HostedServiceHandle } from "@cotal-ai/workspace";
import { SMOKE_BROKER_TOKEN, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { startDeliveryService } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

class MemoryStore implements SecretStore {
  readonly values = new Map<string, string>();
  constructor(readonly identity: { kind: "injected"; coordinate: string }) {}
  async get(k: string) { return this.values.get(k); }
  async put(k: string, v: string) { this.values.set(k, v); }
  async delete(k: string) { this.values.delete(k); }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => Promise<boolean>, timeout = 14_000): Promise<boolean> {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return true; await wait(100); }
  return false;
}

let passed = 0;
function check(label: string, truth: boolean, detail = ""): void {
  if (!truth) throw new Error(`${label} ${detail}`);
  console.log(`  ✓ ${label}`);
  passed++;
}

const port = await pickFreePort();
const monitorPort = await pickFreePort();
const servers = `nats://127.0.0.1:${port}`;
const brokerDir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const broker = await createBrokerAuth("delivery-health-lifetime");
const spaces = [`health-life-a-${Date.now()}`, `health-life-b-${Date.now()}`];
const accounts = await Promise.all(spaces.map((s) => createSpaceAccountAuth(broker, s)));
const auths: SpaceAuth[] = accounts.map((a) => composeSpaceAuth(broker, a));

const confPath = join(brokerDir, "server.conf");
writeFileSync(
  confPath,
  serverConfig(broker, accounts, { transport: { kind: "plaintext" }, port, storeDir: join(brokerDir, "js") }) +
    `\nhttp: 127.0.0.1:${monitorPort}\n`,
);

let nats: ChildProcess = spawn("nats-server", ["-c", confPath], { stdio: "ignore" });
let release = teardownOnSignal(nats, brokerDir);

let hold = false;
let dropped = 0, forwarded = 0;
const liveSockets = new Set<Socket>();
const proxy = createServer((client) => {
  const upstream = connectSocket(port, "127.0.0.1");
  liveSockets.add(client);
  liveSockets.add(upstream);
  const pipe = (to: Socket) => (chunk: Buffer) => {
    if (hold) { dropped++; return; }
    forwarded++;
    if (!to.destroyed) to.write(chunk);
  };
  client.on("data", pipe(upstream));
  upstream.on("data", pipe(client));
  client.on("error", () => upstream.destroy());
  upstream.on("error", () => client.destroy());
  client.on("close", () => { liveSockets.delete(client); upstream.destroy(); });
  upstream.on("close", () => { liveSockets.delete(upstream); client.destroy(); });
});
const proxyPort = await new Promise<number>((resolve, reject) => {
  proxy.once("error", reject);
  proxy.listen(0, "127.0.0.1", () => resolve((proxy.address() as AddressInfo).port));
});

let checksCompleted = false;
const handles: HostedServiceHandle[] = [];
const endpoints: CotalEndpoint[] = [];
const callers: NatsConnection[] = [];

const totalConnections = async (): Promise<number> => {
  const res = await fetch(`http://127.0.0.1:${monitorPort}/varz`);
  if (!res.ok) throw new Error(`monitor returned ${res.status}`);
  return ((await res.json()) as { total_connections: number }).total_connections;
};

try {
  let brokerReady = false;
  for (let i = 0; i < 80; i++) {
    if (await isReachable(servers)) { brokerReady = true; break; }
    await wait(100);
  }
  check("native broker and monitor started", brokerReady);

  const stores: MemoryStore[] = [];
  const deliveryIdentities = [newIdentity(), newIdentity()];
  for (const [i, space] of spaces.entries()) {
    await setupSpaceStreams({ servers, space, creds: await mintCreds(auths[i], newIdentity(), "provisioner") });
    const store = new MemoryStore({ kind: "injected", coordinate: `mem:${space}` });
    stores.push(store);
    const composition = { injected: true as const };
    await store.put(deliveryCredsKey(space, composition), await mintCreds(auths[i], deliveryIdentities[i], "delivery", { expiresInSeconds: 120 }));
    await store.put(membershipRwCredsKey(space, composition), await mintCreds(auths[i], newIdentity(), "membership-rw"));
    await store.put(membershipObserverCredsKey(space, composition), await mintMembershipObserverCreds(auths[i], newIdentity()));
  }

  // Space A connects through the proxy (with paired heartbeat 2500/2)
  // Space B connects directly to broker
  const inputs = [
    {
      context: { accountPublicKey: accounts[0].account.pub, lifecycleUid: "life-0" },
      space: spaces[0], servers: `nats://127.0.0.1:${proxyPort}`, store: stores[0], storeIdentity: stores[0].identity, stateDir: join(brokerDir, "state-0"),
    },
    {
      context: { accountPublicKey: accounts[1].account.pub, lifecycleUid: "life-1" },
      space: spaces[1], servers, store: stores[1], storeIdentity: stores[1].identity, stateDir: join(brokerDir, "state-1"),
    },
  ];

  const [first, second] = await Promise.all(inputs.map((input) => startDeliveryService(input)));
  handles.push(first, second);

  check("space A delivery context reports ready", (await first.readiness()).state === "ready");
  check("space B delivery context reports ready", (await second.readiness()).state === "ready");

  // Verify responders are up via direct broker callers
  const ask = await Promise.all(spaces.map(async (space, i) => {
    const id = newIdentity();
    const uid = mintLifecycleUid();
    const creds = await mintCreds(auths[i], id, "agent", { lifecycleUid: uid });
    const nc = await connect({ servers, authenticator: credsAuthenticator(new TextEncoder().encode(creds)), inboxPrefix: `_INBOX_${id.id}` });
    callers.push(nc);
    const subject = controlServiceSubject(space, CONTROL_DELIVERY, DEV_OWNER, id.id);
    return async (): Promise<"answered" | "absent"> => {
      try {
        await nc.request(subject, JSON.stringify({
          op: "listMemberships", args: { lifecycleUid: uid },
          from: { id: `${DEV_OWNER}.${id.id}`, name: "probe", kind: "agent" },
        }), { timeout: 1200, noMux: true, reply: `${subject}.reply.${randomUUID()}` });
        return "answered";
      } catch (e) {
        if (
          e instanceof NoRespondersError ||
          (e instanceof RequestError && e.isNoResponders()) ||
          (e as Error).name === "TimeoutError" ||
          (e as Error).message?.includes("timeout")
        ) return "absent";
        throw e;
      }
    };
  }));

  check("space A delivery control rail answers", (await ask[0]()) === "answered");
  check("space B delivery control rail answers", (await ask[1]()) === "answered");

  // ── 1. Counted healthy connection churn ──────────────────────────────────────
  await wait(500);
  const baselineConns = await totalConnections();
  await wait(2500);
  const postConns = await totalConnections();
  check(
    "healthy interval makes zero additional broker connections (no periodic probe poll)",
    postConns === baselineConns,
    `start=${baselineConns} end=${postConns}`,
  );

  // ── 2. Event-loop lag burst ─────────────────────────────────────────────────
  const burstUntil = Date.now() + 160;
  while (Date.now() < burstUntil) { /* busy stall */ }
  await wait(300);
  check("short event-loop burst creates no extra health dial", (await totalConnections()) === baselineConns);
  check("both delivery contexts remain ready after scheduler burst", (await first.readiness()).state === "ready" && (await second.readiness()).state === "ready");

  // ── 3. Silent packet loss detection on actual delivery daemon ────────────────
  const blackholeStarted = Date.now();
  hold = true;

  // Space A's delivery daemon sends native PINGs every 2500ms (maxPingOut=2).
  // Under byte blackhole, dropped count increases and connection becomes stale.
  const lossDetected = await until(async () => (await ask[0]()) === "absent", 14_000);
  const blackholeDuration = Date.now() - blackholeStarted;

  check("silent byte blackhole dropped native PING packets", dropped >= 2, `dropped=${dropped}`);
  check("actual delivery daemon detects silent packet loss within 15s window", lossDetected && blackholeDuration < 15_000, `duration=${blackholeDuration}ms`);
  check("sibling space B remains ready and answering during space A silent loss", (await second.readiness()).state === "ready" && (await ask[1]()) === "answered");

  // Release proxy blackhole and reset proxy sockets to allow reconnect
  hold = false;
  for (const s of liveSockets) s.destroy();

  const reconnected = await until(async () => (await ask[0]()) === "answered", 10_000);
  check("delivery daemon reconnects and resumes serving once link is restored", reconnected);
  check("space A returns to ready state after link recovery", (await first.readiness()).state === "ready");

  // ── 4. Credential adoption through admin rail ────────────────────────────────
  const supId = newIdentity();
  const sup = new CotalEndpoint({
    space: spaces[0], servers,
    creds: await mintCreds(auths[0], supId, "supervisor"),
    card: { id: supId.id, name: "supervisor", kind: "endpoint" },
    consume: false, watchChannels: false, watchPresence: false, registerPresence: false,
  });
  endpoints.push(sup);
  await sup.start();

  const adminReq = async (op: string, args: Record<string, unknown> = {}) => {
    let last: Error | undefined;
    for (let i = 0; i < 15; i++) {
      try { return await sup.requestDeliveryAdmin(op, args, 10_000); }
      catch (e) { last = e as Error; await wait(250); }
    }
    throw last;
  };

  const renewedCred = await mintCreds(auths[0], deliveryIdentities[0], "delivery", { expiresInSeconds: 120 });
  await stores[0].put(deliveryCredsKey(spaces[0], { injected: true }), renewedCred);

  const adoptReply = await adminReq("reloadCreds");
  check("admin reloadCreds succeeds with valid re-signed credential", adoptReply.ok === true, JSON.stringify(adoptReply));

  await wait(1000);
  const connsAfterAdopt = await totalConnections();
  check("no continuous connection churn after adoption", (await totalConnections()) === connsAfterAdopt);

  await stores[0].put(deliveryCredsKey(spaces[0], { injected: true }), "corrupted-invalid-cred");
  const failedAdoptReply = await adminReq("reloadCreds");
  check("reloadCreds refuses invalid credential candidate", failedAdoptReply.ok === false, JSON.stringify(failedAdoptReply));

  await stores[0].put(deliveryCredsKey(spaces[0], { injected: true }), renewedCred);

  // ── 5. Sibling context isolation on drain/close ─────────────────────────────
  await first.drain();
  check("space A context transitions out of ready on drain", (await first.readiness()).state !== "ready");
  check("sibling space B remains ready after space A closes", (await second.readiness()).state === "ready");
  check("space B control rail still answers after space A closes", (await ask[1]()) === "answered");

  // Recover through the public adoption rail AFTER a real credential expiry. A socket reconnect
  // alone must not clear the health backstop; the broker-verified adoption callbacks do that.
  const expiryWindowMs = 15_000;
  const expiryBackstopMs = 18_000;
  process.env.COTAL_DELIVERY_BROKER_GONE_MS = String(expiryWindowMs);
  process.env.COTAL_DELIVERY_BROKER_GONE_BACKSTOP_MS = String(expiryBackstopMs);
  const expiredCred = await mintCreds(auths[0], deliveryIdentities[0], "delivery", { expiresInSeconds: 8 });
  await stores[0].put(deliveryCredsKey(spaces[0], { injected: true }), expiredCred);
  let expiredAt = 0;
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    if (args.some((v) => String(v).includes("! delivery: credential expired, awaiting proved renewal"))) {
      expiredAt ||= Date.now();
    }
    originalError(...args);
  };
  try {
    const expiryContext = await startDeliveryService({
      ...inputs[0], context: { accountPublicKey: accounts[0].account.pub, lifecycleUid: "life-expiry" },
      servers, stateDir: join(brokerDir, "state-expiry"),
    });
    handles.push(expiryContext);
    check("assembled delivery observes its actual credential-expiry event", await until(async () => expiredAt > 0, 12_000));
    // Expiry closes an existing connection at exp, while a new broker handshake can briefly
    // accept that JWT at the seconds boundary. Observe real refusal instead of assuming equality.
    const oldRefused = await until(async () => {
      try {
        const old = await connect({ servers, reconnect: false, timeout: 2000, authenticator: credsAuthenticator(new TextEncoder().encode(expiredCred)) });
        await old.close();
        return false;
      } catch (error) {
        if (!/expired|authorization|authentication/i.test((error as Error).message)) throw error;
        return true;
      }
    }, 5000);
    check("broker refuses the expired delivery generation", oldRefused);
    const recoveredCred = await mintCreds(auths[0], deliveryIdentities[0], "delivery", { expiresInSeconds: 120 });
    const positive = await connect({ servers, reconnect: false, timeout: 2000, authenticator: credsAuthenticator(new TextEncoder().encode(recoveredCred)) });
    const newGenerationConnected = !positive.isClosed();
    await positive.close();
    check("broker accepts the new delivery generation after old expiry", newGenerationConnected);
    await stores[0].put(deliveryCredsKey(spaces[0], { injected: true }), recoveredCred);
    const recovered = await adminReq("reloadCreds");
    check("public reloadCreds proves adoption after credential expiry", recovered.ok === true);
    await until(async () => Date.now() > expiredAt + expiryBackstopMs + 1200, expiryBackstopMs + 3000);
    check("post-expiry proved adoption survives the original health backstop",
      Date.now() > expiredAt + expiryBackstopMs && (await expiryContext.readiness()).state === "ready");
    check("post-expiry adopted delivery serves its actual control rail", (await ask[0]()) === "answered");
    check("sibling stays ready and serving across another context's expiry and adoption",
      (await second.readiness()).state === "ready" && (await ask[1]()) === "answered");
    await expiryContext.close();
  } finally {
    console.error = originalError;
    delete process.env.COTAL_DELIVERY_BROKER_GONE_MS;
    delete process.env.COTAL_DELIVERY_BROKER_GONE_BACKSTOP_MS;
  }

  await sup.stop();
  for (const c of callers) await c.close();
  callers.length = 0;

  // ── Raw resident transport broker kill & prompt restart (not the daemon) ────
  await second.close();

  const restartAuth = auths[1];
  const residentCred = await mintCreds(restartAuth, newIdentity(), "delivery", { expiresInSeconds: 30 });
  const resident = await connect({
    servers,
    authenticator: credsAuthenticator(new TextEncoder().encode(residentCred)),
    reconnectTimeWait: 200,
    reconnectJitter: 0,
    maxReconnectAttempts: -1,
  });

  const residentEvents: string[] = [];
  const statusWatcher = (async () => {
    for await (const s of resident.status()) {
      if (s.type === "disconnect") residentEvents.push("disconnect");
      if (s.type === "reconnect") residentEvents.push("reconnect");
    }
  })();

  await killAndAwaitExit(nats, "SIGKILL");
  release();

  for (let i = 0; i < 40 && !residentEvents.includes("disconnect"); i++) await wait(100);
  check("broker stop emits disconnect event to resident connection", residentEvents.includes("disconnect"));

  nats = spawn("nats-server", ["-c", confPath], { stdio: "ignore" });
  release = teardownOnSignal(nats, brokerDir);

  for (let i = 0; i < 60 && !residentEvents.includes("reconnect"); i++) await wait(100);
  check("resident connection reconnects upon broker restart", residentEvents.includes("reconnect"));

  await resident.close();
  await statusWatcher;

  // The presence bucket is memory-backed (#1356), so the restart removed it. `cotal up` provisions
  // the space after it starts a broker (postStart -> setupSpaceStreams), and this suite stands in
  // for that step. Without it the next delivery context fails its presence bind with "stream not found".
  await setupSpaceStreams({ servers, space: spaces[0], creds: await mintCreds(auths[0], newIdentity(), "provisioner") });

  // ── 7. Sustained broker loss detection ──────────────────────────────────────
  process.env.COTAL_DELIVERY_BROKER_GONE_MS = "1200";
  process.env.COTAL_DELIVERY_BROKER_GONE_BACKSTOP_MS = "3000";

  const lossContext = await startDeliveryService({
    context: { accountPublicKey: accounts[0].account.pub, lifecycleUid: `life-loss` },
    space: spaces[0], servers, store: stores[0], storeIdentity: stores[0].identity, stateDir: join(brokerDir, "state-loss"),
  });
  handles.push(lossContext);

  check("loss-test delivery context starts ready", (await lossContext.readiness()).state === "ready");

  await killAndAwaitExit(nats, "SIGKILL");
  release();

  const lossStart = Date.now();
  const becameUnavailable = await until(async () => (await lossContext.readiness()).state === "unavailable", 6000);
  check("sustained broker loss transitions delivery context to unavailable", becameUnavailable);
  check("broker loss detected within bounded window", Date.now() - lossStart < 6000);

  const cause = ((await lossContext.readiness()) as { cause?: string }).cause;
  check("unavailable cause names stopped context", /stopped \(code 1\)/i.test(String(cause)), `cause=${cause}`);
  check("close reports the lease release broker loss left unconfirmed", await lossContext.close().then(() => false, () => true));
  handles.splice(handles.indexOf(lossContext), 1);

  assert.equal(passed, 33, "all native health and post-expiry checks ran");
  checksCompleted = true;
} finally {
  delete process.env.COTAL_DELIVERY_BROKER_GONE_MS;
  delete process.env.COTAL_DELIVERY_BROKER_GONE_BACKSTOP_MS;
  const cleanupErrors: unknown[] = [];
  for (const handle of handles) await handle.close().catch((e) => cleanupErrors.push(e));
  for (const endpoint of endpoints) await endpoint.stop().catch((e) => cleanupErrors.push(e));
  for (const caller of callers) await caller.close().catch((e) => cleanupErrors.push(e));
  for (const s of liveSockets) s.destroy();
  await new Promise<void>((resolve) => proxy.close(() => resolve()));
  try {
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "native health fixture cleanup failed; broker directory retained");
    if (checksCompleted) {
      // A closed context must not retain a reconnecting socket. Bring back the SAME native broker
      // after every owned caller/context closed; HTTP monitoring creates no NATS connections.
      nats = spawn("nats-server", ["-c", confPath], { stdio: "ignore" });
      release = teardownOnSignal(nats, brokerDir);
      assert.ok(await until(async () => {
        try { return (await fetch(`http://127.0.0.1:${monitorPort}/varz`)).ok; } catch { return false; }
      }, 5000), "teardown-audit broker starts");
      const before = await totalConnections();
      await wait(4500);
      const stats = await (await fetch(`http://127.0.0.1:${monitorPort}/varz`)).json() as { connections: number; total_connections: number };
      if (stats.connections !== 0 || stats.total_connections !== before) {
        const census = await (await fetch(`http://127.0.0.1:${monitorPort}/connz?auth=1`)).json() as { connections: { name?: string; account?: string; authorized_user?: string }[] };
        console.log("remaining native connection identities", JSON.stringify(census.connections.map(({ name, account, authorized_user }) => ({ name, account, authorized_user }))));
      }
      check("closed delivery contexts leave no connected or reconnecting broker clients",
        stats.connections === 0 && stats.total_connections === before,
        `active=${stats.connections} totalBefore=${before} totalAfter=${stats.total_connections}`);
    }
  } finally {
    await killAndAwaitExit(nats, "SIGKILL");
    release();
    if (!cleanupErrors.length) rmSync(brokerDir, { recursive: true, force: true });
  }
}
check("fixture closes its proxy and broker and removes its owned state before success",
  !proxy.listening && (nats.exitCode !== null || nats.signalCode !== null) && !existsSync(brokerDir));
assert.equal(passed, 35, "native health fixture includes broker-censused teardown");
console.log(`delivery native health lifetime: ${passed} passed, 0 failed`);
