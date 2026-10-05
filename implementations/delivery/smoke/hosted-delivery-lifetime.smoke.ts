import nodeAssert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { connect, credsAuthenticator, NoRespondersError, RequestError, type NatsConnection } from "@nats-io/transport-node";
import {
  CotalEndpoint, composeSpaceAuth, createBrokerAuth, createSpaceAccountAuth, isReachable, mintCreds,
  mintMembershipObserverCreds, mintLifecycleUid, newIdentity, serverConfig, setupSpaceStreams,
  controlServiceSubject, connzRequestSubject, MEMBERSHIP_INBOX_PREFIX, CONTROL_DELIVERY, DEV_OWNER,
  type SecretStore, type SpaceAuth,
} from "@cotal-ai/core";
import { deliveryCredsKey, membershipObserverCredsKey, membershipRwCredsKey, type HostedServiceHandle } from "@cotal-ai/workspace";
import { SMOKE_BROKER_TOKEN, countedAssert, emitSentinel, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { startDeliveryService } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

const counted = countedAssert(nodeAssert);
const assert: typeof nodeAssert = counted.assert;
const cells = counted.cells;

class MemoryStore implements SecretStore {
  readonly values = new Map<string, string>();
  constructor(readonly identity: { kind: "injected"; coordinate: string }) {}
  async get(k: string) { return this.values.get(k); }
  async put(k: string, v: string) { this.values.set(k, v); }
  async delete(k: string) { this.values.delete(k); }
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => Promise<boolean>, timeout = 10_000): Promise<boolean> {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return true; await wait(100); }
  return false;
}
const port = await pickFreePort();
const servers = `nats://127.0.0.1:${port}`;
const broker = await createBrokerAuth("delivery-hosted-lifetime");
const spaces = [`embedded-a-${Date.now()}`, `embedded-b-${Date.now()}`];
const accounts = await Promise.all(spaces.map((s) => createSpaceAccountAuth(broker, s)));
const auths: SpaceAuth[] = accounts.map((a) => composeSpaceAuth(broker, a));
const brokerDir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(brokerDir, "server.conf"), serverConfig(broker, accounts, { transport: { kind: "plaintext" }, port, storeDir: join(brokerDir, "js") }));
const nats = spawn("nats-server", ["-c", join(brokerDir, "server.conf")], { stdio: "ignore" });
const release = teardownOnSignal(nats, brokerDir);
const inspectors: CotalEndpoint[] = [];
const handles: HostedServiceHandle[] = [];
const callers: NatsConnection[] = [];
try {
  assert.equal(await until(() => isReachable(servers)), true, "broker ready");
  const stores: MemoryStore[] = [];
  for (const [i, space] of spaces.entries()) {
    await setupSpaceStreams({ servers, space, creds: await mintCreds(auths[i], newIdentity(), "provisioner") });
    const store = new MemoryStore({ kind: "injected", coordinate: `memory:${space}` });
    stores.push(store);
    const composition = { injected: true as const };
    await store.put(deliveryCredsKey(space, composition), await mintCreds(auths[i], newIdentity(), "delivery"));
    await store.put(membershipRwCredsKey(space, composition), await mintCreds(auths[i], newIdentity(), "membership-rw"));
    await store.put(membershipObserverCredsKey(space, composition), await mintMembershipObserverCreds(auths[i], newIdentity()));
    const id = newIdentity();
    const ep = new CotalEndpoint({ space, servers, creds: await mintCreds(auths[i], id, "delivery"), card: { id: id.id, name: "inspector", kind: "endpoint" }, channels: [], consume: false, watchChannels: false, watchPresence: false, registerPresence: false });
    ep.on("error", () => {});
    await ep.start();
    inspectors.push(ep);
  }
  const inputs = spaces.map((space, i) => ({
    context: { accountPublicKey: accounts[i].account.pub, lifecycleUid: `life-${i}` },
    space, servers, store: stores[i], storeIdentity: stores[i].identity, stateDir: join(brokerDir, `state-${i}`),
  }));
  // A broker request, not the handle's own state or lease row, witnesses whether the owned
  // Plane-3 control responder still serves after the host is fenced.
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
          from: { id: `${DEV_OWNER}.${id.id}`, name: "fence-probe", kind: "agent" },
        }), { timeout: 1500, noMux: true, reply: `${subject}.reply.${randomUUID()}` });
        return "answered";
      } catch (e) {
        if (e instanceof NoRespondersError || (e instanceof RequestError && e.isNoResponders())) return "absent";
        throw e; // a timeout or permission refusal is not proof that the responder is gone
      }
    };
  }));
  const observers = await Promise.all(accounts.map(async (account, i) => {
    const nc = await connect({ servers, authenticator: credsAuthenticator(new TextEncoder().encode(await mintMembershipObserverCreds(auths[i], newIdentity()))), inboxPrefix: MEMBERSHIP_INBOX_PREFIX });
    callers.push(nc);
    return async (): Promise<number> => {
      const reply = `${MEMBERSHIP_INBOX_PREFIX}.hosted.${randomUUID()}`;
      const sub = nc.subscribe(reply, { max: 1 });
      try {
        nc.publish(connzRequestSubject(account.account.pub), JSON.stringify({ subscriptions: false, limit: 1024 }), { reply });
        await nc.flush();
        const response = await Promise.race([
          (async () => { for await (const msg of sub) return msg.json<{ data?: { connections?: Array<{ name?: string }> } }>(); })(),
          wait(2000).then(() => undefined),
        ]);
        if (!response?.data?.connections) throw new Error("broker CONNZ did not answer the assigned account");
        return response.data.connections.filter((c) => c.name === "cotal:delivery").length;
      } finally { sub.unsubscribe(); }
    };
  }));
  const signals = process.listenerCount("SIGTERM");
  const exits = process.exit;
  await assert.rejects(startDeliveryService({ ...inputs[0], store: { get: (key: string) => stores[0].get(key), put: (key: string, value: string) => stores[0].put(key, value), delete: (key: string) => stores[0].delete(key) } }), /must declare a stable identity/, "identity-less store refuses");
  await assert.rejects(startDeliveryService({ ...inputs[0], storeIdentity: stores[1].identity }), /identity does not match/, "wrong store identity refuses");
  await assert.rejects(startDeliveryService({ ...inputs[0], context: { ...inputs[0].context, accountPublicKey: inputs[1].context.accountPublicKey } }), /credential account does not match/, "credential account does not match");
  const [first, second] = await Promise.all(inputs.map((input) => startDeliveryService(input)));
  handles.push(first, second);
  assert.deepEqual(first.readiness(), { state: "ready", context: inputs[0].context }, "A ready with assigned identity");
  assert.deepEqual(second.readiness(), { state: "ready", context: inputs[1].context }, "B ready with assigned identity");
  assert.equal(await until(async () => Boolean((await inspectors[0].readDeliveryLease(0))?.ready && (await inspectors[1].readDeliveryLease(0))?.ready)), true, "both distinct accounts hold ready delivery leases");
  assert.equal(await ask[0](), "answered", "A answers its native delivery control request before the fence");
  assert.equal(await ask[1](), "answered", "B answers its native delivery control request before the fence");
  assert.equal(await observers[0](), 1, "broker sees A's live delivery connection");
  assert.equal(await observers[1](), 1, "broker sees B's live delivery connection");
  await assert.rejects(startDeliveryService(inputs[0]), /wrong last sequence|lease|already exists/i, "duplicate must refuse locally");
  assert.equal(process.exit, exits, "no process exit during context-local failure");
  assert.equal(process.listenerCount("SIGTERM"), signals, "no hosted global signal listeners");
  assert.equal((await second.readiness()).state, "ready", "sibling remains ready after rejected duplicate");
  await first.drain();
  assert.equal((await inspectors[0].readDeliveryLease(0))?.ready, undefined, "A releases its lease on drain");
  assert.equal((await inspectors[1].readDeliveryLease(0))?.ready, true, "B retains its lease");
  assert.equal((await second.readiness()).state, "ready", "B remains ready after A closes");
  const restarted = await startDeliveryService(inputs[0]);
  handles.push(restarted);
  assert.equal((await inspectors[0].readDeliveryLease(0))?.ready, true, "A can restart after release");
  assert.equal((await second.readiness()).state, "ready", "B remains ready after A restarts");
  const held = await inspectors[0].readDeliveryLeaseEntry(0);
  assert.ok(held !== undefined, "A's restarted lease is readable");
  await inspectors[0].markDeliveryLeaseNotReady(0, held.revision);
  assert.equal(await until(async () => (await restarted.readiness()).state === "unavailable"), true, "fenced A reports unavailable");
  assert.match(String(((await restarted.readiness()) as { cause?: string }).cause), /stopped \(code 1\)/, "fenced A names its stop cause");
  assert.equal((await inspectors[0].readDeliveryLease(0))?.holder, inspectors[0].card.id, "fenced A leaves the new holder's row intact");
  assert.equal(process.exit, exits, "no process exit after a fence");
  assert.equal((await second.readiness()).state, "ready", "B remains ready after A is fenced");
  assert.equal((await inspectors[1].readDeliveryLease(0))?.ready, true, "B keeps its lease after A is fenced");
  assert.equal(await until(async () => (await ask[0]()) === "absent"), true, "fenced A stops answering its owned delivery control rail");
  assert.equal(await ask[1](), "answered", "B still answers its delivery control rail after A is fenced");
  assert.equal(await until(async () => (await observers[0]()) === 0), true, "fenced A closes its broker connection after withdrawing its delivery duty");
  assert.equal(await observers[1](), 1, "broker still sees B's delivery connection after A is fenced");
  const taken = await inspectors[0].readDeliveryLeaseEntry(0);
  await inspectors[0].releaseDeliveryLease(0, taken?.revision);
  await restarted.close();
  await first.close();
  await second.close();
  await second.close();
  assert.equal((await inspectors[1].readDeliveryLease(0))?.ready, undefined, "B releases only its own lease");
  console.log(`hosted delivery lifetime: ${cells()} two-account assertions passed`);
  emitSentinel({ passed: cells(), failed: 0 });
} finally {
  for (const h of handles) await h.close();
  for (const nc of callers) await nc.close();
  for (const ep of inspectors) { try { await ep.stop(); } catch { /* broker may be gone */ } }
  await killAndAwaitExit(nats, "SIGKILL");
  nats.unref();
  if (existsSync(brokerDir)) rmSync(brokerDir, { recursive: true, force: true });
  release();
}
