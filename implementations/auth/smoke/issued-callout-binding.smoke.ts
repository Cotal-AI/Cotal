import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator, tokenAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { decode, encodeUser, fmtCreds, type User } from "@nats-io/jwt";
import { createUser, fromPublic, fromSeed } from "@nats-io/nkeys";
import { SignJWT, generateKeyPair } from "jose";
import { Kvm } from "@nats-io/kv";
import { jetstreamManager } from "@nats-io/jetstream";
import { createSpaceAuth, serverConfig, createEndpointStreams, epAuthBucket, recordsBucket, lifecycleHeadKey, credRowKey, isReachable } from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { createCalloutAuth, type StartAuthCalloutOpts } from "../src/callout.js";
import { activateLifecycle, openLifecycleRegistry } from "../src/lifecycle-registry.js";
import { stageAgentMint, finalizeAgentMint, markLedgerRowRevoked } from "../src/credential-ledger.js";
import { makeLedgerScannerOverConnection } from "../src/ledger-scanner.js";
import { ensureRootCredential } from "../src/root-credential.js";
import { authorizeConnectCredential, openConnectReader } from "../src/connect-reader.js";
import { USER_TOKEN_VER } from "../src/token.js";
import { deriveOwnerToken } from "../src/derive.js";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";
import { evidenceKey, openIssuedLifecycle, type IssuedRef } from "../../../packages/core/smoke/prototypes/issued-authority-lifecycle.js";
import { importNativeSubjectPermissions } from "../../../packages/core/smoke/prototypes/issued-subject-permissions.js";
import { issuedRequestRows, issuedRequestSubject } from "../../../packages/core/smoke/prototypes/issued-static-connection.js";
import { prepareCredentialReleaseFence } from "./prototypes/credential-release-fence.js";
import { gateIssuedCallout, issuedCalloutName, readIssuedCalloutName } from "./prototypes/issued-callout-gate.js";
import { discoverIssuedAuthority, ISSUED_DISCOVERY_GRANT } from "../../../packages/core/smoke/prototypes/issued-generation-discovery.js";

let passed = 0;
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); } catch (error) { console.error(`  FAIL: ${name}`); throw error; }
  console.log(`  ok ${name}`); passed++;
}
const enc = (s: string) => new TextEncoder().encode(s);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(test: () => boolean, label: string) {
  for (let i = 0; i < 150; i++) { if (test()) return; await wait(20); }
  throw new Error(`timeout: ${label}`);
}
const random = () => randomBytes(16).toString("hex");
const space = "issuedcallout";
const auth = await createSpaceAuth(space);
const callout = await createCalloutAuth({ space, operatorSeed: auth.operator.seed, accountPub: auth.account.pub });
const key = createUser();
const operatorJwt = await encodeUser("isolated-issuer", fromPublic(key.getPublicKey()), fromPublic(auth.account.pub), { pub: { allow: [">"] }, sub: { allow: [">"] } }, { signer: fromSeed(enc(auth.account.signingSeed)) });
const port = await pickFreePort(), server = `nats://127.0.0.1:${port}`;
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { host: "127.0.0.1", port, storeDir: join(dir, "js"), transport: { kind: "plaintext" }, extraAccounts: [{ pub: callout.account.pub, jwt: callout.account.jwt }] }), { mode: 0o600 });
const broker = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const exited = new Promise<void>((resolve) => { broker.once("exit", () => resolve()); broker.once("error", () => resolve()); });
const releaseBroker = teardownOnSignal(broker, dir);
const connections: NatsConnection[] = [];
try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(server); if (!up) await wait(50); }
  assert.ok(up);
  const operator = await connect({ servers: server, authenticator: credsAuthenticator(fmtCreds(operatorJwt, key)), maxReconnectAttempts: 0 });
  connections.push(operator);
  const kvm = new Kvm(operator);
  await createEndpointStreams(await jetstreamManager(operator), kvm, space);
  const reg = await openLifecycleRegistry(operator, space, makeLedgerScannerOverConnection(operator, space));
  const reader = await openConnectReader(operator, space);
  const authKv = await kvm.open(epAuthBucket(space));
  const kv = await kvm.create(`cotal_issued_${space}`, { storage: "file", allow_direct: false });
  const lifecycle = await openIssuedLifecycle(kv, space);
  const owner = deriveOwnerToken("callout-prototype-secret".repeat(2), "human-proof");
  const actor = "calloutproof";
  const active = await activateLifecycle(reg, { owner, actor, managerInstance: "proof" });
  const uid = active.mapping.lifecycleUid;
  const credentialId = await ensureRootCredential(reg, { owner, actor, lifecycleUid: uid, managerInstance: "proof" });
  const credentialKey = credRowKey(uid, credentialId);
  const ledger = JSON.parse(new TextDecoder().decode((await authKv.get(credentialKey))!.value));
  const signing = await generateKeyPair("EdDSA");
  const issuerUrl = "https://issuer.example.test";
  const now = Math.floor(Date.now() / 1000);
  const bearer = await new SignJWT({ scope: [], ver: USER_TOKEN_VER, act: { owner, actor, lifecycleUid: uid, credentialId } })
    .setProtectedHeader({ alg: "EdDSA" }).setSubject(owner).setAudience(space).setIssuer(issuerUrl)
    .setIssuedAt(now).setNotBefore(now).setExpirationTime(now + 300).sign(signing.privateKey);
  const capability = { endpoint: "proof.bound", command: "inspect" };
  const refFor = (generation: string): IssuedRef => ({ space, owner, actor, uid, generation });
  let expanded = false, failNext = false;
  let override: string | undefined;
  let hold: Promise<void> | undefined, entered = false;
  const issued = new Map<string, ReturnType<typeof importNativeSubjectPermissions>>();
  const opts: StartAuthCalloutOpts = {
    xkeySeed: callout.xkey.seed,
    authAccount: { pub: callout.account.pub, signingSeed: callout.account.signingSeed },
    dataAccount: { pub: auth.account.pub, signingSeed: auth.account.signingSeed },
    space, token: { key: signing.publicKey, issuer: issuerUrl },
    expectedServerIds: [operator.info!.server_id],
    async authorizeActor(token) {
      assert.equal(token.owner, owner); assert.equal(token.act.actor, actor);
      await authorizeConnectCredential(reader, token, Date.now);
    },
    permissionsFor(_token, name) {
      const proposed = readIssuedCalloutName(name);
      return { pub: { allow: [...issuedRequestRows(refFor(override ?? proposed.generation), capability), "proof.allowed", ISSUED_DISCOVERY_GRANT, ...(expanded ? ["proof.new"] : [])] }, sub: { allow: [`_INBOX_${name}.>`] } };
    },
    log() {},
  };
  const calloutNc = await connect({ servers: server, authenticator: credsAuthenticator(enc(callout.calloutCreds)), maxReconnectAttempts: 0 });
  connections.push(calloutNc);
  const sub = calloutNc.subscribe("$SYS.REQ.USER.AUTH", { queue: "cotal-auth-callout" });
  const errors: unknown[] = [];
  const pending = new Set<Promise<void>>();
  const pump = (async () => {
    for await (const msg of sub) {
      const task = gateIssuedCallout(msg, opts, async (success) => {
        const proposed = readIssuedCalloutName(success.connectionName);
        const ref = refFor(override ?? proposed.generation);
        assert.equal(success.token.act.credentialId, credentialId);
        const claims = decode<User>(success.userJwt);
        assert.equal(claims.exp, success.token.exp);
        const permissions = importNativeSubjectPermissions({ pub: claims.nats.pub, sub: claims.nats.sub });
        const mint = await stageAgentMint(reg, { lifecycleUid: uid, credentialId, holderPrincipal: `${owner}.${actor}`, sourceChain: ["root"], exp: ledger.exp });
        const fence = await prepareCredentialReleaseFence(authKv, uid, credentialId);
        const sources = [...mint.pins.map((pin) => ({ space, bucket: epAuthBucket(space), key: pin.key })),
          { space, bucket: epAuthBucket(space), key: credentialKey },
          { space, bucket: recordsBucket(space), key: lifecycleHeadKey(owner, actor) }];
        const staged = await lifecycle.stage(ref, permissions, sources, success.userJwt);
        entered = true;
        await hold;
        await lifecycle.release(staged, () => fence.finalize(async () => {
          if (failNext) { failNext = false; throw new Error("synthetic issuer failure"); }
          await authorizeConnectCredential(reader, success.token, Date.now);
          await finalizeAgentMint(reg, mint);
        }));
        issued.set(ref.generation, permissions);
      }).catch((error) => { errors.push(error); });
      pending.add(task);
      void task.finally(() => pending.delete(task));
    }
  })();
  await calloutNc.flush();
  for (const subject of ["proof.allowed", "proof.new"]) {
    const witness = operator.subscribe(subject);
    void (async () => { for await (const msg of witness) msg.respond(enc("received")); })();
  }
  const seen = new Set<string>();
  const requests = operator.subscribe(`cotal.${space}.ep.v1.one.>`, { queue: "proof-bound" });
  void (async () => { for await (const msg of requests) seen.add(new TextDecoder().decode(msg.data)); })();
  await operator.flush();
  async function open(generation: string, name = issuedCalloutName(generation, random()), token: string | null = bearer) {
    const nc = await connect({ servers: server, authenticator: token ? [credsAuthenticator(enc(callout.sentinelCreds)), tokenAuthenticator(token)] : credsAuthenticator(enc(callout.sentinelCreds)), name, inboxPrefix: `_INBOX_${name}`, reconnect: false, maxReconnectAttempts: 0, timeout: 4000 });
    connections.push(nc);
    return { nc, ref: Object.freeze(refFor(generation)) };
  }
  async function deniedPublish(nc: NatsConnection, subject: string) {
    let denied = false;
    const events = nc.status();
    const watch = (async () => { for await (const event of events) if (event.type === "error" && /permission/i.test(String(event.error))) { denied = true; break; } })();
    nc.publish(subject, enc("forbidden")); await nc.flush();
    await until(() => denied, "native publish denial"); await watch;
  }
  const generation = random();
  let unblock!: () => void;
  hold = new Promise<void>((resolve) => { unblock = resolve; });
  let settled = false;
  const connecting = open(generation);
  void connecting.then(() => { settled = true; }, () => { settled = true; });
  await check("prepared callout success stays private until the awaited issuer gate completes", async () => {
    try {
      await until(() => entered || settled, "issuer gate entry");
      assert.equal(entered, true); assert.equal(settled, false);
      const state = JSON.parse(new TextDecoder().decode((await kv.get(`attempt.${evidenceKey(refFor(generation))}`))!.value));
      assert.equal(state.state, "prepared");
    } finally { unblock(); hold = undefined; }
  });
  const first = await connecting;
  await check("committed callout credentials rebind into the data account and scoped inbox", async () => {
    assert.ok(issued.has(generation));
    const reply = await first.nc.request("proof.allowed", enc("hello"), { timeout: 2000 });
    assert.equal(new TextDecoder().decode(reply.data), "received");
  });
  expanded = true;
  const laterGeneration = random();
  const later = await open(laterGeneration);
  await check("same bearer with a new generation gets new scope without widening the old connection", async () => {
    const reply = await later.nc.request("proof.new", enc("hello"), { timeout: 2000 });
    assert.equal(new TextDecoder().decode(reply.data), "received");
    await deniedPublish(first.nc, "proof.new");
    assert.notDeepEqual(issued.get(generation), issued.get(laterGeneration));
  });
  const request = () => ({ route: { mode: "one" as const }, ...capability, nonce: random() });
  await check("callout-issued generation grants deliver own requests and reject substitution", async () => {
    const id = random();
    first.nc.publish(issuedRequestSubject(first.ref, request()), enc(id)); await first.nc.flush();
    await until(() => seen.has(id), "own generation delivery");
    await deniedPublish(first.nc, issuedRequestSubject(later.ref, request()));
    await deniedPublish(later.nc, issuedRequestSubject(first.ref, request()));
  });
  await check("callout generation reuse refuses instead of silently reminting", async () => {
    await assert.rejects(open(generation));
  });
  await check("issuer failure sends a signed denial and leaves no active attempted generation", async () => {
    failNext = true; const refused = random();
    await assert.rejects(open(refused));
    const state = JSON.parse(new TextDecoder().decode((await kv.get(`attempt.${evidenceKey(refFor(refused))}`))!.value));
    assert.equal(state.state, "aborted"); assert.equal(issued.has(refused), false);
  });
  await check("legacy and future connection metadata receive no issued fallback", async () => {
    await assert.rejects(open(random(), "legacyinbox1234"));
    await assert.rejects(open(random(), `ia2_${random()}_${random()}`));
  });
  await check("missing and signature-tampered bearers cannot reach issued release", async () => {
    const missing = random();
    await assert.rejects(open(missing, issuedCalloutName(missing, random()), null));
    const parts = bearer.split(".");
    parts[2] = (parts[2][0] === "a" ? "b" : "a") + parts[2].slice(1);
    const forged = random();
    await assert.rejects(open(forged, issuedCalloutName(forged, random()), parts.join(".")));
    assert.equal(issued.has(missing), false); assert.equal(issued.has(forged), false);
    assert.equal(await kv.get(evidenceKey(refFor(missing))), null);
    assert.equal(await kv.get(evidenceKey(refFor(forged))), null);
  });
  await check("a callout client discovers the generation the issuer bound, not the one it proposed", async () => {
    // The connection name is a client proposal. Acceptance alone cannot tell the client which
    // generation the issuer actually bound, so it reads that back from the server.
    const proposed = random();
    override = random();
    try {
      const client = await open(proposed);
      const discovered = await discoverIssuedAuthority(client.nc, space);
      assert.equal(discovered.generation, override);
      assert.notEqual(discovered.generation, proposed);
      assert.deepEqual(discovered, refFor(override));
      await deniedPublish(client.nc, issuedRequestSubject(refFor(proposed), request()));
    } finally { override = undefined; }
  });
  await check("revoked bearer credential is refused by the unchanged callout authorization path", async () => {
    await markLedgerRowRevoked(authKv, credentialKey);
    await assert.rejects(open(random()));
  });
  sub.unsubscribe(); await pump; await Promise.all(pending);
  assert.deepEqual(errors, []);
  console.log(`issued callout binding prototype: ${passed} passed`);
} finally {
  for (const nc of connections) await nc.close();
  if (broker.exitCode === null && broker.signalCode === null) broker.kill("SIGTERM");
  const stopped = await Promise.race([exited.then(() => true), wait(2000).then(() => false)]);
  if (!stopped) { broker.kill("SIGKILL"); await exited; }
  rmSync(dir, { recursive: true, force: true }); releaseBroker();
}
