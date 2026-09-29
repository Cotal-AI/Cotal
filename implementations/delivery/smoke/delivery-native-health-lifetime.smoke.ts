/**
 * Delivery daemon native transport health and embedded service lifetime smoke.
 *
 * Exercises the ACTUAL delivery daemon and embedded delivery paths:
 * 1. Counted healthy connection churn: zero additional broker connections over time (no polling).
 * 2. Successful and failed credential adoption via delivery-admin rail and injected SecretStore.
 * 3. Context isolation: sibling context remains serving when one context closes or faults.
 * 4. Broker restart: resident daemon recovers without exit when broker restarts promptly.
 * 5. Sustained broker loss: daemon exits within bounded window when broker is gone.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { connect, credsAuthenticator, NoRespondersError, RequestError, type NatsConnection } from "@nats-io/transport-node";
import {
  CotalEndpoint, composeSpaceAuth, createBrokerAuth, createSpaceAccountAuth, isReachable, mintCreds,
  mintMembershipObserverCreds, mintLifecycleUid, newIdentity, serverConfig, setupSpaceStreams,
  controlServiceSubject, CONTROL_DELIVERY, DEV_OWNER, idFromCreds,
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
async function until(check: () => Promise<boolean>, timeout = 12_000): Promise<boolean> {
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
    await store.put(deliveryCredsKey(space, composition), await mintCreds(auths[i], deliveryIdentities[i], "delivery", { expiresInSeconds: 60 }));
    await store.put(membershipRwCredsKey(space, composition), await mintCreds(auths[i], newIdentity(), "membership-rw"));
    await store.put(membershipObserverCredsKey(space, composition), await mintMembershipObserverCreds(auths[i], newIdentity()));
  }

  const inputs = spaces.map((space, i) => ({
    context: { accountPublicKey: accounts[i].account.pub, lifecycleUid: `life-${i}` },
    space, servers, store: stores[i], storeIdentity: stores[i].identity, stateDir: join(brokerDir, `state-${i}`),
  }));

  const [first, second] = await Promise.all(inputs.map((input) => startDeliveryService(input)));
  handles.push(first, second);

  check("space A delivery context reports ready", (await first.readiness()).state === "ready");
  check("space B delivery context reports ready", (await second.readiness()).state === "ready");

  // Verify responders are up
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
        }), { timeout: 2500, noMux: true, reply: `${subject}.reply.${randomUUID()}` });
        return "answered";
      } catch (e) {
        if (e instanceof NoRespondersError || (e instanceof RequestError && e.isNoResponders())) return "absent";
        throw e;
      }
    };
  }));

  check("space A delivery control rail answers", (await ask[0]()) === "answered");
  check("space B delivery control rail answers", (await ask[1]()) === "answered");

  // ── 1. Counted healthy connection churn ──────────────────────────────────────
  // Wait to let startup connections settle
  await wait(500);
  const baselineConns = await totalConnections();
  // Wait 2500ms (exceeding the old 2000ms probe interval which made 2+ conns every 2s)
  await wait(2500);
  const postConns = await totalConnections();
  check(
    "healthy interval makes zero additional broker connections (no periodic probe poll)",
    postConns === baselineConns,
    `start=${baselineConns} end=${postConns}`,
  );

  // ── 2. Credential adoption through admin rail ────────────────────────────────
  const supId = newIdentity();
  const sup = new CotalEndpoint({
    space: spaces[0], servers,
    creds: await mintCreds(auths[0], supId, "supervisor"),
    card: { id: supId.id, name: "supervisor", kind: "endpoint" },
    consume: false, watchChannels: false, watchPresence: false, registerPresence: false,
  });
  endpoints.push(sup);
  await sup.start();

  // Re-sign Space A's delivery cred for the same identity and put in store
  const renewedCred = await mintCreds(auths[0], deliveryIdentities[0], "delivery", { expiresInSeconds: 120 });
  await stores[0].put(deliveryCredsKey(spaces[0], { injected: true }), renewedCred);

  const connsBeforeAdopt = await totalConnections();
  const adoptReply = await sup.requestDeliveryAdmin("reloadCreds", {}, 10_000);
  check("admin reloadCreds succeeds with valid re-signed credential", adoptReply.ok === true, JSON.stringify(adoptReply));

  // Disposable preflight creates exactly one short connection, but no continuous churn after
  await wait(1000);
  const connsAfterAdopt = await totalConnections();
  check("no continuous connection churn after adoption", (await totalConnections()) === connsAfterAdopt);

  // Negative adoption control: corrupted / expired credential in store refuses reloadCreds
  await stores[0].put(deliveryCredsKey(spaces[0], { injected: true }), "corrupted-invalid-cred");
  const failedAdoptReply = await sup.requestDeliveryAdmin("reloadCreds", {}, 10_000);
  check("reloadCreds refuses invalid credential candidate", failedAdoptReply.ok === false, JSON.stringify(failedAdoptReply));

  // Restore valid credential
  await stores[0].put(deliveryCredsKey(spaces[0], { injected: true }), renewedCred);

  // ── 3. Sibling context isolation on drain/close ─────────────────────────────
  await first.drain();
  check("space A context transitions out of ready on drain", (await first.readiness()).state !== "ready");
  check("sibling space B remains ready after space A closes", (await second.readiness()).state === "ready");
  check("space B control rail still answers after space A closes", (await ask[1]()) === "answered");

  // Close supervisor and callers before broker restart test
  await sup.stop();
  for (const c of callers) await c.close();
  callers.length = 0;

  // ── 4. Standalone daemon broker kill & prompt restart ───────────────────────
  // Launch standalone delivery daemon on space B with custom short broker gone window
  const standaloneState = join(brokerDir, "state-standalone");
  const standaloneStore = new MemoryStore({ kind: "injected", coordinate: "mem:standalone" });
  const standaloneId = newIdentity();
  await standaloneStore.put(deliveryCredsKey(spaces[1], { injected: true }), await mintCreds(auths[1], standaloneId, "delivery", { expiresInSeconds: 60 }));
  await standaloneStore.put(membershipRwCredsKey(spaces[1], { injected: true }), await mintCreds(auths[1], newIdentity(), "membership-rw"));
  await standaloneStore.put(membershipObserverCredsKey(spaces[1], { injected: true }), await mintMembershipObserverCreds(auths[1], newIdentity()));

  // Close second context before starting standalone on same space
  await second.close();

  // Test broker restart with a resident endpoint connection using short native ping
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

  // Kill broker with SIGKILL
  await killAndAwaitExit(nats, "SIGKILL");
  release();

  for (let i = 0; i < 40 && !residentEvents.includes("disconnect"); i++) await wait(100);
  check("broker stop emits disconnect event to resident connection", residentEvents.includes("disconnect"));

  // Restart broker quickly
  nats = spawn("nats-server", ["-c", confPath], { stdio: "ignore" });
  release = teardownOnSignal(nats, brokerDir);

  for (let i = 0; i < 60 && !residentEvents.includes("reconnect"); i++) await wait(100);
  check("resident connection reconnects upon broker restart", residentEvents.includes("reconnect"));

  await resident.close();
  await statusWatcher;

  // ── 5. Sustained broker loss detection ──────────────────────────────────────
  // Re-start embedded delivery service on space A with short broker gone window
  process.env.COTAL_DELIVERY_BROKER_GONE_MS = "1200";
  process.env.COTAL_DELIVERY_BROKER_GONE_BACKSTOP_MS = "3000";

  const lossContext = await startDeliveryService({
    context: { accountPublicKey: accounts[0].account.pub, lifecycleUid: `life-loss` },
    space: spaces[0], servers, store: stores[0], storeIdentity: stores[0].identity, stateDir: join(brokerDir, "state-loss"),
  });
  handles.push(lossContext);

  check("loss-test delivery context starts ready", (await lossContext.readiness()).state === "ready");

  // Permanently kill broker
  await killAndAwaitExit(nats, "SIGKILL");
  release();

  const lossStart = Date.now();
  const becameUnavailable = await until(async () => (await lossContext.readiness()).state === "unavailable", 6000);
  check("sustained broker loss transitions delivery context to unavailable", becameUnavailable);
  check("broker loss detected within bounded window", Date.now() - lossStart < 6000);

  const cause = ((await lossContext.readiness()) as { cause?: string }).cause;
  check("unavailable cause names stopped context", /stopped \(code 1\)/i.test(String(cause)), `cause=${cause}`);

  console.log(`delivery native health lifetime: ${passed} passed, 0 failed`);
  process.exit(0);
} finally {
  delete process.env.COTAL_DELIVERY_BROKER_GONE_MS;
  delete process.env.COTAL_DELIVERY_BROKER_GONE_BACKSTOP_MS;
  await killAndAwaitExit(nats, "SIGKILL");
  release();
  rmSync(brokerDir, { recursive: true, force: true });
}
