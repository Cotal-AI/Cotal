/** Real hosted startAuthService over an owned broker and delayed TCP link. Ordinary receipt
 * fixtures exercise startup, continuation, expiry and shutdown. The separate service callout
 * suites cover authentic service receipts and their retention. No daemon or OS service is used. */
import { strict as nodeAssert } from "node:assert";
import { countedAssert, emitSentinel } from "@cotal-ai/smoke-kit";
import { connect as connectTcp, createServer, type Socket } from "node:net";
import { setTimeout as wait } from "node:timers/promises";
import { Kvm } from "@nats-io/kv";
import { createServer as createServerKey, createUser } from "@nats-io/nkeys";
import { contractDigest, epAuthBucket, mintCreds, mintLifecycleUid, newIdentity, serviceEndpointActor, setupSpaceStreams } from "@cotal-ai/core";
import { startAuthService, type AuthServiceHandle } from "@cotal-ai/auth";
import { openAuthorityClient } from "../src/authority-client.js";
import { openLifecycleRegistry, registryStores } from "../src/lifecycle-registry.js";
import { CorruptNativeIssuanceEvidence, makeNativeIssuancePruner } from "../src/native-issuance.js";
import { startHostedAuthFixture } from "./_hosted-auth-fixture.js";

const counted = countedAssert(nodeAssert);
const assert: typeof nodeAssert = counted.assert;
const cells = counted.cells;
const fixture = await startHostedAuthFixture("natstart", 1);
const account = fixture.accounts[0]!;
const { space, store, stateDir, accountPublicKey, auth } = account;
const quiet = () => {};
const dataAccount = { pub: auth.account.pub, signingSeed: auth.account.signingSeed! };
const admin = await openAuthorityClient({ server: fixture.servers, space, dataAccount,
  label: `smoke:${space}`, grants: (id) => ({ publish: [">"], subscribe: [`_INBOX_${id}.>`] }), log: quiet });
const sockets = new Set<Socket>();
const timers = new Set<ReturnType<typeof setTimeout>>();
let delayMs = 0, reads = 0;
const scanSequences: number[] = [];
const pipe = (source: Socket, target: Socket) => {
  source.on("data", (data: Buffer) => {
    const timer = setTimeout(() => { timers.delete(timer); if (!target.destroyed) target.write(data); }, delayMs);
    timers.add(timer);
  });
  source.on("end", () => target.end());
  source.on("error", () => target.destroy());
};
const proxy = createServer((client) => {
  const upstream = connectTcp(Number(new URL(fixture.servers).port), "127.0.0.1");
  for (const socket of [client, upstream]) {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  }
  let partial = "";
  client.on("data", (chunk: Buffer) => {
    const lines = (partial + chunk.toString("latin1")).split("\r\n");
    partial = lines.pop()!;
    for (const line of lines) {
      if (!line.includes('"next_by_subj"') || !line.includes(".natkey.>")) continue;
      reads++;
      scanSequences.push((JSON.parse(line) as { seq: number }).seq);
    }
  });
  pipe(client, upstream);
  pipe(upstream, client);
});
await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
const address = proxy.address();
assert(address && typeof address === "object");
const servers = `nats://127.0.0.1:${address.port}`;
let service: AuthServiceHandle | undefined;
const open = (nativeIssuancePruneMs?: number) => {
  const inputs = { context: { accountPublicKey, lifecycleUid: mintLifecycleUid() }, space, servers,
    store, storeIdentity: store.identity, stateDir,
    ...(nativeIssuancePruneMs !== undefined ? { nativeIssuancePruneMs } : {}) };
  return startAuthService(inputs);
};
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const record = (exp: number) => ({ v: 1, space, owner: `u_${"a".repeat(26)}`, actor: "fixture",
  lifecycleUid: mintLifecycleUid(), credentialId: mintLifecycleUid(), view: "agent", connId: "fixture", iat: 1, exp });
const until = async (test: () => boolean | Promise<boolean>, message: string, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await test()) return; await wait(20); }
  assert.fail(message);
};

const serviceRecord = (() => {
  const base = record(2);
  const coordinates = { accountPublicKey, space, endpoint: "org.example.cleanup", instanceId: mintLifecycleUid() };
  const actor = serviceEndpointActor({ ...coordinates, owner: base.owner });
  const witness = { ...coordinates, principal: { owner: base.owner, actor, lifecycleUid: base.lifecycleUid },
    rootCredentialId: base.credentialId, approvalDigest: contractDigest({ approval: true }), processEpoch: 1,
    registrationRevision: 1, nameAuthorityRevision: 1, registrationRequestId: "a".repeat(32), registrationProof: contractDigest({ registered: true }) };
  const serverId = createServerKey().getPublicKey();
  return (userNkey: string, clientId: number) => ({ ...base, actor, view: "service-endpoint",
    service: { witness, credentialId: mintLifecycleUid(), connection: { userNkey, serverId, clientId } } });
})();
try {
  await setupSpaceStreams({ servers: fixture.servers, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  const kv = await new Kvm(admin.nc).open(epAuthBucket(space));
  const registry = await openLifecycleRegistry(admin.nc, space);
  // One leader read at 30 ms RTT is harmless. Hundreds of serialized reads are not.
  delayMs = 15;
  service = await open();
  assert.equal((await fetch(`${service.url}/health`)).status, 200);
  await service.close(); service = undefined;
  console.log("positive control: empty history starts and serves health through delayed broker");
  delayMs = 0;
  const bootBad = `natkey.${createUser().getPublicKey()}`;
  await kv.create(bootBad, encode({ v: 1 }));
  await assert.rejects(open(), /natkey/);
  await kv.purge(bootBad);
  console.log("corrupt evidence in the startup check refuses the hosted context");
  const live: string[] = [];
  for (let i = 0; i < 256; i++) {
    const key = `natkey.${createUser().getPublicKey()}`;
    await kv.create(key, encode(record(Math.floor(Date.now() / 1000) + 3600)));
    live.push(key);
  }
  const expired = `natkey.${createUser().getPublicKey()}`;
  await kv.create(expired, encode(record(2)));
  delayMs = 15;
  reads = 0;
  const started = performance.now();
  service = await open();
  const startupMs = performance.now() - started;
  assert.equal((await fetch(`${service.url}/health`)).status, 200);
  assert(reads < 64, `startup must not await the historical walk, observed ${reads} reads`);
  console.log(`populated startup serves health in ${Math.round(startupMs)} ms after ${reads} reads`);
  await until(async () => (await kv.get(expired))?.operation === "PURGE", "background continuation must reach and prune the expired tail");
  for (const key of live) assert.equal((await kv.get(key))?.operation, "PUT");
  console.log("background continuation reaches expired evidence beyond retained rows without deleting live evidence");
  await service.close(); service = undefined;
  delayMs = 0;
  for (const key of live) await kv.purge(key);
  assert.equal(await makeNativeIssuancePruner(registry)(10, 1), true, "a purge marker consumes the batch budget");
  const aborted = AbortSignal.abort();
  await assert.rejects(makeNativeIssuancePruner(registry, aborted)(10), { name: "AbortError" });
  await assert.rejects(makeNativeIssuancePruner(registry)(10, 0), /positive safe integer/);
  // Race the deferred purge after its leader read, then see the replacement on retry.
  const raceKey = `natkey.${createUser().getPublicKey()}`;
  const due = `natkey.${createUser().getPublicKey()}`;
  await kv.create(raceKey, encode(record(2)));
  await kv.create(due, encode(record(2)));
  const prune = makeNativeIssuancePruner(registry);
  assert.equal(await prune(7), false, "expiry plus tolerance is still live");
  assert.equal((await kv.get(due))?.operation, "PUT");
  const { authKv } = registryStores(registry);
  const purge = authKv.purge.bind(authKv);
  authKv.purge = async (key, opts) => {
    if (key === raceKey) await kv.put(key, encode(record(100)));
    return purge(key, opts);
  };
  try { await assert.rejects(prune(8)); }
  finally { authKv.purge = purge; }
  assert.equal(await prune(8), false);
  assert.equal((await kv.get(due))?.operation, "PURGE");
  assert.equal((await kv.get(raceKey))?.operation, "PUT", "sequence-pinned purge must preserve a concurrent replacement");
  assert.equal(await prune(106), false);
  assert.equal((await kv.get(raceKey))?.operation, "PURGE", "the replacement revision still receives its own expiry check");
  console.log("bounded markers, cancellation and sequence-pinned purge race passed");
  // Corruption after the boot budget must still fence the running service, never skip a row.
  const bad = `natkey.${createUser().getPublicKey()}`;
  await kv.create(bad, encode({ v: 1 }));
  service = await open();
  await until(async () => (await service!.readiness()).state === "unavailable", "corrupt background evidence did not fence service");
  const failedState = await service.readiness();
  assert(failedState.state === "unavailable" && failedState.cause.includes("native-issuance cleanup failed"));
  await service.close();
  await service.closed;
  assert(service.connections().every((connection) => connection.ended));
  service = undefined;
  await assert.rejects(makeNativeIssuancePruner(registry)(10), CorruptNativeIssuanceEvidence);
  await kv.purge(bad);
  console.log("corrupt evidence beyond the startup budget fences the hosted context");
  await assert.rejects(open(50), /nativeIssuancePruneMs/);
  await assert.rejects(async () => {
    // @ts-expect-error JavaScript hosts can pass null, which must not select the default.
    await (await open(null)).close();
  }, /nativeIssuancePruneMs.*got null/);
  // A live ordinary receipt before the retained history must not pin the discovery cursor.
  const anchor = `natkey.${createUser().getPublicKey()}`;
  await kv.create(anchor, encode(record(Math.floor(Date.now() / 1000) + 3600)));
  const retained = new Map<string, number>();
  for (let clientId = 1; clientId <= 130; clientId++) {
    const userNkey = createUser().getPublicKey(), key = `natkey.${userNkey}`;
    retained.set(key, await kv.create(key, encode(serviceRecord(userNkey, clientId))));
  }
  const historyEnd = [...retained.values()].at(-1)! + 1;
  scanSequences.length = 0;
  service = await open(500);
  assert.equal((await fetch(`${service.url}/health`)).status, 200);
  await until(() => scanSequences.includes(historyEnd), "startup walk did not reach the end of the retained history");
  const endOfStartup = scanSequences.indexOf(historyEnd) + 1;
  const newExpired = `natkey.${createUser().getPublicKey()}`;
  await kv.create(newExpired, encode(record(2)));
  await until(async () => (await kv.get(newExpired))?.operation === "PURGE", "hosted cadence missed newly appended expired evidence", 8_000);
  const periodic = scanSequences.slice(endOfStartup);
  console.log(`periodic walk starts at sequence ${periodic[0]} and issued ${periodic.length} wildcard reads before purging the new receipt`);
  assert(periodic[0]! >= historyEnd && periodic.length <= 8, "periodic cleanup reread the retained service history");
  for (const [key, revision] of retained) assert.equal((await kv.get(key))?.revision, revision, "retained service evidence must remain unchanged");
  assert.equal((await kv.get(anchor))?.operation, "PUT", "older live ordinary receipt must remain");
  assert.equal((await service.readiness()).state, "ready");
  const retainedKey = retained.keys().next().value!;
  await kv.update(retainedKey, encode({ v: 1 }), retained.get(retainedKey)!);
  await until(async () => (await service!.readiness()).state === "unavailable", "replacement of a retained receipt must fence the service");
  const replacedState = await service.readiness();
  assert(replacedState.state === "unavailable" && replacedState.cause.includes("native-issuance cleanup failed"));
  await service.close(); service = undefined;
  await kv.purge(retainedKey);
  // Close while a walk is in flight. It must finish the current IO, not the whole history.
  for (let i = 0; i < 256; i++) await kv.create(`natkey.${createUser().getPublicKey()}`, encode(record(2)));
  delayMs = 15;
  reads = 0;
  service = await open();
  const closeStarted = performance.now();
  await service.close(); service = undefined;
  assert(performance.now() - closeStarted < 4000, "close must cancel historical cleanup between store operations");
  const readsAtClose = reads;
  await wait(150);
  assert.equal(reads, readsAtClose, "close must leave no cleanup timer or flight");
  console.log("close cancels cleanup without draining history or leaving a timer");
} finally {
  await service?.close();
  await admin.close();
  for (const socket of sockets) socket.destroy();
  for (const timer of timers) clearTimeout(timer);
  await new Promise<void>((resolve) => proxy.close(() => resolve()));
  // Retain broker state as evidence, and stop the exact broker this fixture owns.
  await fixture.stopBroker();
}
console.log("native issuance startup smoke passed");
emitSentinel({ passed: cells(), failed: 0 });
