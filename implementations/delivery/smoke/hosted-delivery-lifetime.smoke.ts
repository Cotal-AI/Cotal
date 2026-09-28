import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CotalEndpoint, composeSpaceAuth, createBrokerAuth, createSpaceAccountAuth, isReachable, mintCreds,
  mintMembershipObserverCreds, newIdentity, serverConfig, setupSpaceStreams, type SecretStore, type SpaceAuth,
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
  const taken = await inspectors[0].readDeliveryLeaseEntry(0);
  await inspectors[0].releaseDeliveryLease(0, taken?.revision);
  await restarted.close();
  await first.close();
  await second.close();
  await second.close();
  assert.equal((await inspectors[1].readDeliveryLease(0))?.ready, undefined, "B releases only its own lease");
  console.log("hosted delivery lifetime: 24 two-account assertions passed");
} finally {
  for (const h of handles) await h.close();
  for (const ep of inspectors) { try { await ep.stop(); } catch { /* broker may be gone */ } }
  await killAndAwaitExit(nats, "SIGKILL");
  nats.unref();
  if (existsSync(brokerDir)) rmSync(brokerDir, { recursive: true, force: true });
  release();
}
