import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { decode, encodeUser, fmtCreds, type User } from "@nats-io/jwt";
import { createUser, fromPublic, fromSeed } from "@nats-io/nkeys";
import { Kvm } from "@nats-io/kv";
import { jetstreamManager } from "@nats-io/jetstream";
import { createEndpointStreams, createSpaceAuth, epAuthBucket, isReachable, serverConfig } from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { activateLifecycle, openLifecycleRegistry } from "../src/lifecycle-registry.js";
import { stageAgentMint, finalizeAgentMint } from "../src/credential-ledger.js";
import { makeLedgerScannerOverConnection } from "../src/ledger-scanner.js";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";
import { epRequestSubject } from "../../../packages/core/src/endpoint-subjects.js";
import { openIssuedLifecycle, type IssuedRef } from "../../../packages/core/smoke/prototypes/issued-authority-lifecycle.js";
import { importNativeSubjectPermissions, permitsSubject } from "../../../packages/core/smoke/prototypes/issued-subject-permissions.js";
import { connectIssuedStatic, issuedStaticTag, issuedRequestRows, issuedReplyFilter, issuedRequestSubject } from "../../../packages/core/smoke/prototypes/issued-static-connection.js";
import { discoverIssuedAuthority, ISSUED_DISCOVERY_GRANT } from "../../../packages/core/smoke/prototypes/issued-generation-discovery.js";
import { classifyIssuedArrival, UNBOUND_REFUSAL } from "../../../packages/core/smoke/prototypes/issued-request-admission.js";
import { acceptedBucket, acceptedKey, acceptedReadGrant, writeAccepted, readAccepted } from "../../../packages/core/smoke/prototypes/issued-accepted-row.js";

let passed = 0;
async function check(name: string, run: () => Promise<void>) {
  try { await run(); } catch (error) { console.error(`  FAIL: ${name}`); throw error; }
  console.log(`  ok ${name}`);
  passed++;
}
const enc = (s: string) => new TextEncoder().encode(s);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(test: () => boolean, label: string) {
  for (let i = 0; i < 150; i++) { if (test()) return; await wait(20); }
  throw new Error(`timeout: ${label}`);
}
const space = "issuedstatic";
const auth = await createSpaceAuth(space);
const signer = fromSeed(enc(auth.account.signingSeed));
async function signed(perms: Partial<User>, name = "prototype") {
  const key = createUser();
  const jwt = await encodeUser(name, fromPublic(key.getPublicKey()), fromPublic(auth.account.pub), perms, { signer, exp: Math.floor(Date.now() / 1000) + 600 });
  return { key, jwt, material: fmtCreds(jwt, key) };
}
const operator = await signed({ pub: { allow: [">"] }, sub: { allow: [">"] } }, "isolated-issuer");
const port = await pickFreePort();
const server = `nats://127.0.0.1:${port}`;
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { host: "127.0.0.1", port, storeDir: join(dir, "js"), transport: { kind: "plaintext" } }), { mode: 0o600 });
const broker = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const exited = new Promise<void>((resolve) => { broker.once("exit", () => resolve()); broker.once("error", () => resolve()); });
const releaseBroker = teardownOnSignal(broker, dir);
const connections: NatsConnection[] = [];
try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(server); if (!up) await wait(50); }
  assert.ok(up, "isolated signed broker must start");
  const issuer = await connect({ servers: server, authenticator: credsAuthenticator(operator.material), maxReconnectAttempts: 0 });
  connections.push(issuer);
  const kvm = new Kvm(issuer);
  await createEndpointStreams(await jetstreamManager(issuer), kvm, space);
  const reg = await openLifecycleRegistry(issuer, space, makeLedgerScannerOverConnection(issuer, space));
  const activated = await activateLifecycle(reg, { owner: "local", actor: "staticproof", managerInstance: "issuer-proof" });
  const caller = { owner: "local", actor: "staticproof", uid: activated.mapping.lifecycleUid };
  const authKv = await kvm.open(epAuthBucket(space));
  const kv = await kvm.create(`cotal_issued_${space}`, { storage: "file", allow_direct: false });
  const lifecycle = await openIssuedLifecycle(kv, space);
  const accepted = await kvm.create(acceptedBucket(space), { storage: "file", allow_direct: true });
  const capability = { endpoint: "proof.bound", command: "inspect" };
  const request = () => ({ route: { mode: "one" as const }, endpoint: capability.endpoint, command: capability.command, nonce: randomBytes(16).toString("hex") });
  const received = new Set<string>();
  const requestSub = issuer.subscribe(`cotal.${space}.ep.v1.one.>`, { queue: "bound-proof" });
  const arrivals: string[] = [];
  const legacySub = issuer.subscribe(`cotal.${space}.ep.one.>`, { queue: "bound-proof" });
  void (async () => { for await (const message of legacySub) arrivals.push(message.subject); })();
  const channelSub = issuer.subscribe("proof.>");
  for (const sub of [requestSub, channelSub]) void (async () => {
    for await (const message of sub) { arrivals.push(message.subject); received.add(new TextDecoder().decode(message.data)); }
  })();
  await issuer.flush();
  async function mint(channels: string[], abort = false, opts: { discoverable?: boolean; tagRef?: IssuedRef } = {}) {
    const ref: IssuedRef = { space, ...caller, generation: randomBytes(16).toString("hex") };
    const native = {
      pub: { allow: [...issuedRequestRows(ref, capability), ...channels, ...(opts.discoverable ? [ISSUED_DISCOVERY_GRANT] : [])], deny: ["proof.secret"] },
      sub: { allow: [issuedReplyFilter(ref), ...(opts.discoverable ? ["_INBOX.>"] : [])] },
    };
    const material = await signed({ ...native, tags: [issuedStaticTag(opts.tagRef ?? ref)] }, "local-staticproof");
    const permissions = importNativeSubjectPermissions(native);
    const mint = await stageAgentMint(reg, { lifecycleUid: ref.uid, credentialId: ref.generation, holderPrincipal: "local.staticproof", sourceChain: ["root"], exp: Date.now() + 600_000 });
    const sources = mint.pins.map((pin) => ({ space, bucket: epAuthBucket(space), key: pin.key }));
    const staged = await lifecycle.stage(ref, permissions, sources, new TextDecoder().decode(material.material));
    if (abort) await lifecycle.retire(ref);
    const released = await lifecycle.release(staged, () => finalizeAgentMint(reg, mint));
    return { ...material, material: enc(released), ref, native, permissions };
  }
  const first = await mint(["proof.public"]);
  const second = await mint(["proof.public", "proof.new", "proof.secret"]);
  async function open(material: Uint8Array) {
    const binding = await connectIssuedStatic(server, material);
    connections.push(binding.nc);
    const status = { errors: 0, reconnects: 0 };
    void (async () => {
      for await (const event of binding.nc.status()) {
        if (event.type === "error" && /permission/i.test(String(event.error))) status.errors++;
        if (event.type === "reconnect") status.reconnects++;
      }
    })();
    return { ...binding, status };
  }
  async function publication(connection: Awaited<ReturnType<typeof open>>, subject: string, allowed: boolean) {
    const id = randomBytes(16).toString("hex");
    const before = connection.status.errors;
    connection.nc.publish(subject, enc(id));
    await connection.nc.flush();
    await until(() => received.has(id) || connection.status.errors > before, "publication outcome");
    assert.equal(received.has(id), allowed);
    assert.equal(connection.status.errors - before, allowed ? 0 : 1);
  }
  const file = join(dir, "client.creds");
  writeFileSync(file, first.material, { mode: 0o600 });
  const input = readFileSync(file);
  const a = await open(input);
  const b = await open(second.material);

  await check("accepted static credentials bind their signed generation to durable issued evidence", async () => {
    assert.deepEqual(a.ref, first.ref);
    const resolved = await lifecycle.resolve(a.ref, async (source) => {
      assert.equal(source.space, space);
      assert.equal(source.bucket, epAuthBucket(space));
      const entry = await authKv.get(source.key);
      assert.ok(entry && entry.operation === "PUT");
      return JSON.parse(new TextDecoder().decode(entry.value)).state === "open";
    });
    const claims = decode<User>(first.jwt);
    assert.deepEqual(resolved, importNativeSubjectPermissions({ pub: claims.nats.pub, sub: claims.nats.sub }));
    assert.equal(permitsSubject(resolved.publish, issuedRequestSubject(first.ref, request())), true);
    assert.equal(permitsSubject(resolved.publish, issuedRequestSubject(second.ref, request())), false);
  });

  await check("the bound publisher delivers a request through its own generation grant", async () => {
    const id = randomBytes(16).toString("hex");
    a.publish(request(), enc(id));
    await a.nc.flush();
    await until(() => received.has(id), "bound request delivery");
    assert.equal(a.status.errors, 0);
  });

  await check("the broker refuses generation substitution in both directions", async () => {
    await publication(a, issuedRequestSubject(second.ref, request()), false);
    await publication(b, issuedRequestSubject(first.ref, request()), false);
  });

  await check("new bound credentials have no legacy request fallback", async () => {
    await publication(a, epRequestSubject(space, { ...request(), caller }), false);
  });

  await check("two connections of one caller retain their separately issued channel ceilings", async () => {
    await publication(a, "proof.public", true);
    await publication(b, "proof.new", true);
    await publication(a, "proof.new", false);
    await publication(b, "proof.secret", false);
  });

  await check("rewriting the credential file does not change a live connection binding", async () => {
    writeFileSync(file, second.material, { mode: 0o600 });
    assert.deepEqual(a.ref, first.ref);
    await publication(a, "proof.new", false);
    const replacement = await open(readFileSync(file));
    assert.deepEqual(replacement.ref, second.ref);
    await publication(replacement, "proof.new", true);
  });

  await check("the client discovers its accepted generation from the server, not from its own credentials", async () => {
    const discoverable = await mint(["proof.public"], false, { discoverable: true });
    const c = await open(discoverable.material);
    assert.deepEqual(await discoverIssuedAuthority(c.nc, space), discoverable.ref);
    // The signed tag is a label; the enforced grant rows are what the broker accepted. When an
    // issuer signs one and grants the other, discovery follows the grants.
    const mismatched = await mint(["proof.public"], false, { discoverable: true, tagRef: discoverable.ref });
    const d = await open(mismatched.material);
    assert.deepEqual(d.ref, discoverable.ref);
    assert.deepEqual(await discoverIssuedAuthority(d.nc, space), mismatched.ref);
    assert.notEqual(mismatched.ref.generation, discoverable.ref.generation);
  });

  await check("a connection without the server-info grant cannot discover its generation", async () => {
    await assert.rejects(discoverIssuedAuthority(a.nc, space));
    const unrestricted = await connect({ servers: server, authenticator: credsAuthenticator(operator.material), maxReconnectAttempts: 0 });
    connections.push(unrestricted);
    await assert.rejects(discoverIssuedAuthority(unrestricted, space), /names no generation|issued generations/);
  });

  await check("discovery refuses ambiguous or unbindable grant rows", async () => {
    const other: IssuedRef = { space, ...caller, generation: randomBytes(16).toString("hex") };
    const foreign: IssuedRef = { space: "otherspace", ...caller, generation: randomBytes(16).toString("hex") };
    const two = await mint(issuedRequestRows(other, capability), false, { discoverable: true });
    await assert.rejects(discoverIssuedAuthority((await open(two.material)).nc, space), /2 issued generations/);
    const wildcard = await mint([`cotal.${space}.ep.v1.one.proof.bound.${caller.owner}.${caller.actor}.${caller.uid}.*.*`], false, { discoverable: true });
    await assert.rejects(discoverIssuedAuthority((await open(wildcard.material)).nc, space), /invalid issued generation/);
    const mixed = await mint(issuedRequestRows(foreign, capability), false, { discoverable: true });
    assert.deepEqual(await discoverIssuedAuthority((await open(mixed.material)).nc, space), mixed.ref);
  });

  await check("replacing the credential file does not change what a live connection discovers", async () => {
    const before = await mint(["proof.public"], false, { discoverable: true });
    const after = await mint(["proof.public"], false, { discoverable: true });
    const live = await open(before.material);
    writeFileSync(file, after.material, { mode: 0o600 });
    assert.deepEqual(await discoverIssuedAuthority(live.nc, space), before.ref);
    const next = await open(readFileSync(file));
    assert.deepEqual(await discoverIssuedAuthority(next.nc, space), after.ref);
  });

  await check("native reconnect retains snapshotted credentials after caller-buffer mutation", async () => {
    input.fill(0);
    const before = a.status.reconnects;
    const clientId = a.nc.info?.client_id;
    await a.nc.reconnect();
    await until(() => a.status.reconnects > before || a.nc.isClosed(), "native reconnect");
    const closed = a.nc.isClosed() ? await a.nc.closed() : undefined;
    assert.equal(a.nc.isClosed(), false, closed?.message);
    assert.notEqual(a.nc.info?.client_id, clientId);
    assert.deepEqual(a.ref, first.ref);
    await publication(a, issuedRequestSubject(first.ref, request()), true);
    await publication(a, "proof.new", false);
  });

  await check("the accepted reference cannot be rewritten by the caller", async () => {
    assert.equal(Object.isFrozen(a.ref), true);
    assert.throws(() => { a.ref.generation = second.ref.generation; }, TypeError);
    assert.deepEqual(a.ref, first.ref);
  });

  await check("an aborted issuance cannot return its prepared signed credentials", async () => {
    await assert.rejects(mint(["proof.public"], true));
  });

  for (const [label, tags] of [
    ["missing", []],
    ["duplicate", [issuedStaticTag(first.ref), issuedStaticTag(first.ref)]],
    ["future", [issuedStaticTag(first.ref).replace(".v1.", ".v2.")]],
    ["malformed", [issuedStaticTag(first.ref).replace(first.ref.generation, "*")]],
  ] as const) {
    await check(`${label} issued metadata cannot establish a static binding`, async () => {
      const credential = await signed({ ...first.native, tags: [...tags] });
      await assert.rejects(connectIssuedStatic(server, credential.material));
    });
  }

  await check("tampering with signed generation metadata cannot establish a binding", async () => {
    const parts = first.jwt.split(".");
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    payload.nats.tags = [issuedStaticTag(second.ref)];
    parts[1] = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const tampered = fmtCreds(parts.join("."), first.key);
    await assert.rejects(connectIssuedStatic(server, tampered));
  });

  await check("an endpoint serving both rails names the refusal for an unbound arrival", async () => {
    const legacy = epRequestSubject(space, { route: { mode: "one" }, ...capability, caller, nonce: randomBytes(16).toString("hex") });
    const bound = issuedRequestSubject(first.ref, request());
    issuer.publish(legacy, enc("legacy")); a.nc.publish(bound, enc("bound"));
    await issuer.flush(); await a.nc.flush();
    await until(() => arrivals.includes(legacy) && arrivals.includes(bound), "both rails arrive");
    assert.deepEqual(classifyIssuedArrival(space, legacy), { kind: "legacy", reason: UNBOUND_REFUSAL });
    assert.deepEqual(classifyIssuedArrival(space, bound), { kind: "issued", ref: first.ref });
  });

  await check("a malformed binding on the versioned rail is refused rather than read as legacy", async () => {
    const parts = issuedRequestSubject(first.ref, request()).split(".");
    parts[parts.length - 2] = "not-a-generation";
    assert.throws(() => classifyIssuedArrival(space, parts.join(".")), /invalid issued generation/);
    assert.throws(() => classifyIssuedArrival(space, `cotal.${space}.ep.v1.bogus.x.y.local.a.${caller.uid}.${"a".repeat(32)}.n`), /unsupported endpoint rail/);
    assert.throws(() => classifyIssuedArrival("elsewhere", issuedRequestSubject(first.ref, request())), /not an endpoint subject/);
  });

  await check("a client can read its accepted generation from its own row instead of the server view", async () => {
    // The alternative to $SYS.REQ.USER.INFO. The client performs the read, so it adds no path by
    // which the server places bytes on a subject the client names.
    const token = randomBytes(16).toString("hex");
    const mine = await mint([acceptedReadGrant(space, token)], false, { discoverable: true });
    await writeAccepted(accepted, token, mine.ref);
    const client = await open(mine.material);
    assert.deepEqual(await readAccepted(client.nc, space, token), mine.ref);
    // The grant names one key, so another caller's row is refused by the broker, not by the reader.
    const other = randomBytes(16).toString("hex");
    await writeAccepted(accepted, other, (await mint([])).ref);
    await assert.rejects(readAccepted(client.nc, space, other));
    // A token with no row refuses rather than resolving to something.
    await assert.rejects(readAccepted(client.nc, space, randomBytes(16).toString("hex")));
    // Redemption is once: the issuer cannot overwrite a token with a second issuance.
    await assert.rejects(writeAccepted(accepted, token, (await mint([])).ref));
    assert.equal(acceptedKey(token), `accepted.v1.${token}`);
  });

  await check("the generation sits at one offset from the tail for every rail mode", async () => {
    // Discovery and admission both parse by tail offset. If any mode broke that, one of them would
    // read a neighbouring token as the generation and still produce a well-formed reference.
    const modes = [
      { route: { mode: "one" as const } },
      { route: { mode: "all" as const } },
      { route: { mode: "inst" as const, instanceId: "i".repeat(26) } },
    ];
    for (const mode of modes) {
      const subject = issuedRequestSubject(first.ref, { ...mode, ...capability, nonce: randomBytes(16).toString("hex") });
      const arrival = classifyIssuedArrival(space, subject);
      assert.equal(arrival.kind, "issued");
      assert.deepEqual(arrival.kind === "issued" ? arrival.ref : undefined, first.ref);
      const legacy = epRequestSubject(space, { ...mode, ...capability, caller: caller, nonce: "n".repeat(32) });
      assert.equal(subject.split(".").length, legacy.split(".").length + 2, `${subject} vs ${legacy}`);
    }
    // The reply filter carries the same tail, which is what the discovery parser walks.
    const filter = issuedReplyFilter(first.ref).split(".");
    assert.equal(filter[filter.length - 2], first.ref.generation);
  });

  await check("the prototype refuses journal capabilities instead of adding a partial rail", async () => {
    assert.throws(() => issuedRequestRows(first.ref, { ...capability, journal: true }), /journal/);
  });
  console.log(`issued static binding prototype: ${passed} passed`);
} finally {
  for (const nc of connections) await nc.close();
  if (broker.exitCode === null && broker.signalCode === null) broker.kill("SIGTERM");
  const stopped = await Promise.race([exited.then(() => true), wait(2000).then(() => false)]);
  if (!stopped) { broker.kill("SIGKILL"); await exited; }
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
}
