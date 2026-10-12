import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { decode, encodeAccount, encodeUser } from "@nats-io/jwt";
import { fromPublic, fromSeed } from "@nats-io/nkeys";
import { composeSpaceAuth, createBrokerAuth, createSpaceAccountAuth, credsFromJwt, EpEnvelopeError, isReachable, newIdentity, serverConfig, type Identity } from "@cotal-ai/core";
import { awaitBrokerReady, emitSentinel, killAndAwaitExit, SMOKE_BROKER_TOKEN, teardownOnSignal, teardownPathOnSignal } from "@cotal-ai/smoke-kit";
import { collectNativeAccountUpdateAcks, type NativeAccountUpdateInput } from "../src/native-account-update-acks.js";
import { pickFreePort } from "./_free-port.js";

const dir = await mkdtemp(join(tmpdir(), SMOKE_BROKER_TOKEN + "native-account-acks-"));
const releasePath = teardownPathOnSignal(dir), children: ChildProcess[] = [], releases: Array<() => void> = [], clients: NatsConnection[] = [];
const enc = (s: string) => new TextEncoder().encode(s);
let passed = 0, failed = 0;
const cell = async (name: string, run: () => Promise<void>) => {
  try { await run(); passed++; console.log(`  ✓ ${name}`); }
  catch (error) { failed++; console.error(`  ✗ ${name}: ${error instanceof Error ? error.message : String(error)}`); }
};
const refuses = (code: string) => (error: unknown) => error instanceof EpEnvelopeError && error.code === code;
try {
  const broker = await createBrokerAuth("native-account-acks-fixture");
  const account = await createSpaceAccountAuth(broker, "native-account-acks-fixture");
  const foreign = await createSpaceAccountAuth(broker, "native-account-acks-foreign");
  const auth = composeSpaceAuth(broker, account), target = newIdentity(), other = newIdentity(), admin = newIdentity();
  const ports: number[] = [], routes: number[] = [];
  for (let i = 0; i < 4; i++) ports.push(await pickFreePort());
  for (let i = 0; i < 2; i++) routes.push(await pickFreePort());
  assert.equal(new Set([...ports, ...routes]).size, 6);
  const urls = ports.map(port => `nats://127.0.0.1:${port}`), stores: string[] = [];
  for (let i = 0; i < 4; i++) {
    const own = join(dir, `node-${i}`); await mkdir(own, { mode: 0o700 });
    const store = join(own, "jwt"); stores.push(store);
    let config = `server_name: native-acks-${i}\n` + serverConfig(broker, [account], {
      port: ports[i], transport: { kind: "plaintext" }, storeDir: join(own, "js"), maxFileStore: 64 * 1024 * 1024,
    });
    if (i < 3) config = config.replace("resolver: MEMORY", `resolver: { type: full, dir: "${store}", allow_delete: false, interval: "2m", limit: 100 }`);
    if (i < 2) config += `cluster { name: native_acks, listen: 127.0.0.1:${routes[i]}, routes: [nats://127.0.0.1:${routes[1 - i]}] }\n`;
    const file = join(own, "server.conf"); await writeFile(file, config, { mode: 0o600 });
    const child = spawn("nats-server", ["-c", file], { stdio: ["ignore", "ignore", "pipe"] });
    children.push(child); releases.push(teardownOnSignal(child));
    let log = ""; child.stderr!.on("data", b => { log = (log + String(b)).slice(-4000); });
    await awaitBrokerReady(() => isReachable(urls[i]!), { servers: urls[i]!, attempts: 50, delayMs: 100, output: () => log });
  }
  const expiresAt = Math.floor(Date.now() / 1000) + 240;
  const user = async (id: Identity, name: string, permissions: Parameters<typeof encodeUser>[3], system = false) => {
    const jwt = await encodeUser(name, fromPublic(id.id), fromPublic(system ? auth.sys.pub : auth.account.pub), permissions,
      { exp: expiresAt, signer: fromSeed(enc(system ? auth.sys.signingSeed! : auth.account.signingSeed!)) });
    assert.equal(decode(jwt).exp, expiresAt);
    return credsFromJwt(jwt, id);
  };
  const targetCreds = await user(target, "acks-target-fixture", { pub: { deny: [">"] }, sub: { allow: [`_INBOX_${target.id}.>`] } });
  const otherCreds = await user(other, "acks-unaffected-fixture", { pub: { allow: ["proof.route"] }, sub: { allow: ["proof.route", `_INBOX_${other.id}.>`] } });
  const subject = `$SYS.REQ.ACCOUNT.${auth.account.pub}.CLAIMS.UPDATE`;
  const adminCreds = await user(admin, "acks-curator-fixture", { pub: { allow: [subject] }, sub: { allow: [`_INBOX_${admin.id}.>`] } }, true);
  const dial = async (i: number, creds: string, id: Identity): Promise<NatsConnection> => {
    assert.ok(Math.floor(Date.now() / 1000) < expiresAt);
    const nc = await connect({ servers: urls[i]!, authenticator: credsAuthenticator(enc(creds)), name: id.id,
      inboxPrefix: `_INBOX_${id.id}`, reconnect: false, timeout: 3000 }); clients.push(nc); await nc.flush(); return nc;
  };
  const targets: NatsConnection[] = [], others: NatsConnection[] = [], admins: NatsConnection[] = [], ids: string[] = [];
  for (let i = 0; i < 4; i++) {
    admins.push(await dial(i, adminCreds, admin)); ids.push(admins[i]!.info!.server_id);
    if (i < 3) { targets.push(await dial(i, targetCreds, target)); others.push(await dial(i, otherCreds, other)); }
  }
  assert.equal(new Set(ids).size, 4);
  let routed = false, disconnected = false;
  const route = others[1]!.subscribe("proof.route", { callback: (e, m) => { assert.ok(!e); routed ||= m.string() === "route-control"; } });
  const absentRoute = others[2]!.subscribe("proof.route", { callback: () => { disconnected = true; } });
  await others[1]!.flush(); await others[2]!.flush();
  const routeDeadline = Date.now() + 8000;
  while (!routed) {
    assert.ok(Date.now() < routeDeadline, "native data route control did not arrive");
    others[0]!.publish("proof.route", enc("route-control")); await others[0]!.flush(); await new Promise(r => setTimeout(r, 50));
  }
  route.unsubscribe(); absentRoute.unsubscribe();
  await cell("native route reaches the second server but not the disconnected holder", async () => { assert.equal(routed, true); assert.equal(disconnected, false); });
  await cell("target and unaffected keys connect on all three full resolvers before updates", async () => {
    assert.ok([...targets, ...others].every(c => !c.isClosed()));
  });
  const original = decode<Record<string, unknown>>(auth.account.jwt), clockDeadline = Date.now() + 6000;
  while (Math.floor(Date.now() / 1000) <= original.iat) { assert.ok(Date.now() < clockDeadline); await new Promise(r => setTimeout(r, 50)); }
  const updated = await encodeAccount(original.name, fromSeed(enc(auth.account.seed!)),
    { ...original.nats, revocations: { [target.id]: Math.floor(Date.now() / 1000) } }, { signer: fromSeed(enc(auth.operator.seed!)) });
  const pin: NativeAccountUpdateInput = { accountPublicKey: auth.account.pub, accountJwt: updated, expectedServerIds: ids.slice(0, 2), maxWaitMs: 350 };
  const before = () => admins[0]!.stats().outMsgs;
  await cell("foreign account claim refuses before native publish", async () => {
    const sent = before(); await assert.rejects(collectNativeAccountUpdateAcks(admins[0]!, { ...pin, accountJwt: foreign.account.jwt }), refuses("failed-precondition")); assert.equal(before(), sent);
  });
  await cell("duplicate required server IDs refuse before native publish", async () => {
    const sent = before(); await assert.rejects(collectNativeAccountUpdateAcks(admins[0]!, { ...pin, expectedServerIds: [...pin.expectedServerIds, ids[0]!] }), refuses("failed-precondition")); assert.equal(before(), sent);
  });
  await cell("empty required server set refuses before native publish", async () => {
    const sent = before(); await assert.rejects(collectNativeAccountUpdateAcks(admins[0]!, { ...pin, expectedServerIds: [] }), refuses("failed-precondition")); assert.equal(before(), sent);
  });
  await cell("malformed server and account tokens refuse before native publish", async () => {
    const sent = before();
    await assert.rejects(collectNativeAccountUpdateAcks(admins[0]!, { ...pin, expectedServerIds: ["N.*"] }), refuses("failed-precondition"));
    await assert.rejects(collectNativeAccountUpdateAcks(admins[0]!, { ...pin, accountPublicKey: "A.*" }), refuses("failed-precondition")); assert.equal(before(), sent);
  });
  await cell("unknown input fields refuse before native publish", async () => {
    const sent = before(); await assert.rejects(collectNativeAccountUpdateAcks(admins[0]!, { ...pin, profile: "admin" } as NativeAccountUpdateInput), refuses("failed-precondition")); assert.equal(before(), sent);
  });
  await cell("zero fractional and over-bound wait budgets refuse before native publish", async () => {
    const sent = before();
    for (const maxWaitMs of [0, 1.5, 30_001]) await assert.rejects(collectNativeAccountUpdateAcks(admins[0]!, { ...pin, maxWaitMs }), refuses("failed-precondition"));
    assert.equal(before(), sent);
  });
  await cell("two required native responders return their exact accepted server set", async () => {
    const result = await collectNativeAccountUpdateAcks(admins[0]!, pin);
    assert.deepEqual(result, { acknowledgedServerIds: ids.slice(0, 2).sort() });
  });
  await cell("routed servers persist the submitted signed claim", async () => {
    for (const store of stores.slice(0, 2)) assert.equal(await readFile(join(store, auth.account.pub + ".jwt"), "utf8"), updated);
  });
  await cell("native revocation closes both routed target holders", async () => {
    for (const c of targets.slice(0, 2)) {
      await Promise.race([c.closed(), new Promise((_, reject) => { const t = setTimeout(() => reject(new Error("routed target still live")), 2000); t.unref(); })]);
      assert.equal(c.isClosed(), true);
    }
  });
  await cell("native revocation refuses new target connections on both routed servers", async () => {
    for (const i of [0, 1]) await assert.rejects(dial(i, targetCreds, target), /authorization|authentication|revoked/i);
  });
  await cell("missing required server refuses instead of declaring update accepted", async () => {
    await assert.rejects(collectNativeAccountUpdateAcks(admins[0]!, { ...pin, expectedServerIds: ids.slice(0, 3) }), refuses("unavailable"));
  });
  await cell("unlisted native responder refuses rather than widening the required set", async () => {
    await assert.rejects(collectNativeAccountUpdateAcks(admins[0]!, { ...pin, expectedServerIds: [ids[0]!] }), refuses("unavailable"));
  });
  await cell("disconnected target stays live and can reconnect while its original claim remains", async () => {
    await targets[2]!.flush(); assert.equal(targets[2]!.isClosed(), false); const c = await dial(2, targetCreds, target); await c.flush();
    assert.equal(await readFile(join(stores[2]!, auth.account.pub + ".jwt"), "utf8"), auth.account.jwt);
  });
  await cell("unaffected keys remain live on all three full resolvers", async () => {
    for (const c of others) { await c.flush(); assert.equal(c.isClosed(), false); }
  });
  await cell("native skipped response is success-coded but is not an update acknowledgment", async () => {
    const raw = (await admins[3]!.request(subject, enc(updated), { timeout: 2000 })).json<{ data: { code: number; message: string } }>();
    assert.equal(raw.data.code, 200); assert.equal(raw.data.message, "jwt update skipped");
    await assert.rejects(collectNativeAccountUpdateAcks(admins[3]!, { ...pin, expectedServerIds: [ids[3]!] }), refuses("unavailable"));
  });
  await cell("invalid signature refuses locally before native publish", async () => {
    const parts = updated.split("."); parts[2] = (parts[2]![0] === "A" ? "B" : "A") + parts[2]!.slice(1);
    const sent = before();
    await assert.rejects(collectNativeAccountUpdateAcks(admins[0]!, { ...pin, accountJwt: parts.join(".") }), refuses("failed-precondition"));
    assert.equal(before(), sent);
  });
  await cell("native claim validation failure returns no accepted server set", async () => {
    const bad = await encodeAccount(original.name, fromPublic(auth.account.pub), { ...original.nats, signing_keys: ["not-a-signing-key"] },
      { signer: fromSeed(enc(auth.operator.seed!)) });
    assert.equal(decode(bad).sub, auth.account.pub);
    await assert.rejects(collectNativeAccountUpdateAcks(admins[0]!, { ...pin, accountJwt: bad }), refuses("unavailable"));
    for (const store of stores.slice(0, 2)) assert.equal(await readFile(join(store, auth.account.pub + ".jwt"), "utf8"), updated);
  });
  await cell("closed host connection refuses without reporting acceptance", async () => {
    const c = await dial(0, adminCreds, admin); await c.close(); await assert.rejects(collectNativeAccountUpdateAcks(c, pin), refuses("unavailable"));
  });
} finally {
  for (const c of clients.reverse()) await c.close();
  for (const c of children) {
    await killAndAwaitExit(c, "SIGTERM");
    assert.ok(c.exitCode !== null || c.signalCode !== null, "owned native broker must have exited before removing its store");
  }
  for (const release of releases) release();
  await rm(dir, { recursive: true, force: true }); releasePath();
}
emitSentinel({ passed, failed });
if (failed) process.exitCode = 1;
