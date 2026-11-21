/** Real hosted startAuthService over an owned broker. A delayed TCP link exercises startup and
 * shutdown, and leader-read tracing checks periodic cleanup with staged service receipt history.
 * Separate callout suites cover authentic service issuance. */
import { strict as nodeAssert } from "node:assert";
import { countedAssert, emitSentinel } from "@cotal-ai/smoke-kit";
import { connect as connectTcp, createServer, type Socket } from "node:net";
import { setTimeout as wait } from "node:timers/promises";
import { Kvm } from "@nats-io/kv";
import { createUser } from "@nats-io/nkeys";
import { contractDigest, epAuthBucket, mintCreds, mintLifecycleUid, nativeIssuanceKey, newIdentity, serviceEndpointActor, setupSpaceStreams } from "@cotal-ai/core";
import { startAuthService, type AuthServiceHandle } from "@cotal-ai/auth";
import { openAuthorityClient } from "../src/authority-client.js";
import { openLifecycleRegistry, registryStores } from "../src/lifecycle-registry.js";
import { CorruptNativeIssuanceEvidence, makeNativeIssuancePruner } from "../src/native-issuance.js";
import { startHostedAuthFixture, type HostedAuthAccount } from "./_hosted-auth-fixture.js";

const counted = countedAssert(nodeAssert);
const assert: typeof nodeAssert = counted.assert;
const cells = counted.cells;
const fixture = await startHostedAuthFixture("natstart", 2, { keepFiles: true });
const account = fixture.accounts[0]!;
const { space, store, stateDir, accountPublicKey, auth } = account;
const quiet = () => {};
const dataAccount = { pub: auth.account.pub, signingSeed: auth.account.signingSeed! };
const admin = await openAuthorityClient({ server: fixture.servers, space, dataAccount,
  label: `smoke:${space}`, grants: (id) => ({ publish: [">"], subscribe: [`_INBOX_${id}.>`] }), log: quiet });
const sockets = new Set<Socket>();
const timers = new Set<ReturnType<typeof setTimeout>>();
let delayMs = 0, reads = 0;
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
    reads += lines.filter((line) => line.includes('"next_by_subj"') && line.includes(".natkey.>")).length;
  });
  pipe(client, upstream);
  pipe(upstream, client);
});
await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
const address = proxy.address();
assert(address && typeof address === "object");
const servers = `nats://127.0.0.1:${address.port}`;
let service: AuthServiceHandle | undefined;
const open = () => startAuthService({ context: { accountPublicKey, lifecycleUid: mintLifecycleUid() },
  space, servers, store, storeIdentity: store.identity, stateDir });
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const record = (exp: number, rowSpace = space) => ({ v: 1, space: rowSpace, owner: `u_${"a".repeat(26)}`, actor: "fixture",
  lifecycleUid: mintLifecycleUid(), credentialId: mintLifecycleUid(), view: "agent", connId: "fixture", iat: 1, exp });
const until = async (test: () => Promise<boolean>, message: string) => {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) { if (await test()) return; await wait(20); }
  assert.fail(message);
};

async function checkPeriodicTraffic({ space, accountPublicKey, auth, store, stateDir }: HostedAuthAccount): Promise<void> {
  await setupSpaceStreams({ servers: fixture.servers, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  const bucket = epAuthBucket(space), readSubject = `$JS.API.STREAM.MSG.GET.KV_${bucket}`;
  const observer = await openAuthorityClient({ server: fixture.servers, space, dataAccount: { pub: accountPublicKey, signingSeed: auth.account.signingSeed! },
    label: `smoke:${space}`, grants: (id) => ({ publish: [">"], subscribe: [`_INBOX_${id}.>`, readSubject] }), log: quiet });
  let hosted: AuthServiceHandle | undefined;
  try {
    const kv = await new Kvm(observer.nc).open(bucket);
    const putOrdinary = async (exp: number) => {
      const key = nativeIssuanceKey(createUser().getPublicKey());
      await kv.create(key, encode(record(exp, space)));
      return key;
    };
    const beforeHistory = await putOrdinary(Math.floor(Date.now() / 1000) + 3);
    const serviceRows = await seedRetainedHistory(kv, space, accountPublicKey, observer.nc.info!.server_id);
    const historySeqs = new Set(serviceRows.map(({ seq }) => seq));
    const lastHistorySeq = serviceRows.at(-1)!.seq;
    const reads: number[] = [];
    let exactHistoryReads = 0;
    observer.nc.subscribe(readSubject, { callback: (_err, msg) => {
      const req = msg.json<{ next_by_subj?: string; seq?: number }>();
      if (req.seq === undefined) return;
      if (req.next_by_subj === `$KV.${bucket}.natkey.>`) reads.push(req.seq);
      else if (req.next_by_subj === undefined && historySeqs.has(req.seq)) exactHistoryReads++;
    } });
    await observer.nc.flush();
    const inputs = { context: { accountPublicKey, lifecycleUid: mintLifecycleUid() }, space, servers: fixture.servers,
      store, storeIdentity: store.identity, stateDir, nativeIssuancePruneMs: 100 };
    await assert.rejects(startAuthService({ ...inputs, nativeIssuancePruneMs: 50 }), /nativeIssuancePruneMs/);
    hosted = await startAuthService(inputs);
    assert.equal((await fetch(`${hosted.url}/health`)).status, 200);
    await until(async () => reads.includes(lastHistorySeq + 1), "startup walk did not reach the end of retained history");
    const start = reads.length;
    const expired = await putOrdinary(2);
    const liveAfterHistory = await putOrdinary(Math.floor(Date.now() / 1000) + 3600);
    await until(async () => (await kv.get(expired))?.operation === "PURGE", "periodic walk did not purge new expired ordinary evidence");
    const historyReads = reads.slice(start).filter((seq) => seq <= lastHistorySeq).length + exactHistoryReads;
    console.log(`periodic walk purged new ordinary evidence; ${historyReads} reads targeted checked service history`);
    assert.equal(historyReads, 0, "periodic cleanup must not reread retained service history");
    await until(async () => (await kv.get(beforeHistory))?.operation === "PURGE", "ordinary receipt before retained history was never revisited");
    assert.equal(exactHistoryReads, 0, "expiration of old live evidence must not trigger history reads");
    assert.equal((await kv.get(liveAfterHistory))?.operation, "PUT");
    for (const { key, seq } of serviceRows) assert.equal((await kv.get(key))?.revision, seq, "service receipt must remain unchanged");
    await kv.put(serviceRows[0]!.key, encode({ v: 1 }));
    await until(async () => (await hosted!.readiness()).state === "unavailable", "corrupt new revision of checked evidence did not fence the host");
    assert.equal((await kv.get(serviceRows[0]!.key))?.operation, "PUT", "corrupt evidence must not be purged");
    console.log("periodic cleanup retained service receipts, revisited old live evidence, and fenced on a corrupt replacement");
  } finally {
    await hosted?.close();
    await observer.close();
  }
}

async function seedRetainedHistory(kv: Awaited<ReturnType<Kvm["open"]>>, space: string, accountPublicKey: string, serverId: string) {
  const owner = `u_${"a".repeat(26)}`;
  const coordinates = { space, accountPublicKey, endpoint: "org.example.history", instanceId: mintLifecycleUid() };
  const principal = { owner, actor: serviceEndpointActor({ ...coordinates, owner }), lifecycleUid: mintLifecycleUid() };
  const rootCredentialId = mintLifecycleUid(), digest = contractDigest({ fixture: "native-issuance" });
  const witness = { ...coordinates, principal, rootCredentialId, approvalDigest: digest, registrationProof: digest,
    processEpoch: 1, registrationRevision: 1, nameAuthorityRevision: 1, registrationRequestId: "a".repeat(32) };
  const history: { key: string; seq: number }[] = [];
  for (let i = 0; i < 96; i++) {
    const userNkey = createUser().getPublicKey(), key = nativeIssuanceKey(userNkey);
    const seq = await kv.create(key, encode({ ...record(2, space), ...principal, credentialId: rootCredentialId, view: "service-endpoint",
      service: { witness, credentialId: mintLifecycleUid(), connection: { userNkey, serverId, clientId: i + 1 } } }));
    history.push({ key, seq });
  }
  return history;
}

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
  const prune = makeNativeIssuancePruner(registry);
  assert(await prune(Math.floor(Date.now() / 1000), 1), "purge markers consume the batch budget");
  const aborted = AbortSignal.abort();
  await assert.rejects(prune(10, 1, aborted), { name: "AbortError" });
  await assert.rejects(prune(10, 0), /positive safe integer/);
  // Force a real CAS race at the purge, without replacing the store operation.
  const raceKey = `natkey.${createUser().getPublicKey()}`;
  await kv.create(raceKey, encode(record(2)));
  const { authKv } = registryStores(registry);
  const purge = authKv.purge.bind(authKv);
  authKv.purge = async (key, opts) => {
    if (key === raceKey) await kv.put(key, encode(record(Math.floor(Date.now() / 1000) + 3600)));
    return purge(key, opts);
  };
  try { assert.equal(await prune(Math.floor(Date.now() / 1000), 512), false, "one stale purge must not stop the pass"); }
  finally { authKv.purge = purge; }
  assert.equal((await kv.get(raceKey))?.operation, "PUT", "sequence-pinned purge must preserve a concurrent replacement");
  await kv.purge(raceKey);
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
  await assert.rejects(prune(10, 512), CorruptNativeIssuanceEvidence);
  await kv.purge(bad);
  console.log("corrupt evidence beyond the startup budget fences the hosted context");
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
  await checkPeriodicTraffic(fixture.accounts[1]!);
} finally {
  await service?.close();
  await admin.close();
  for (const socket of sockets) socket.destroy();
  for (const timer of timers) clearTimeout(timer);
  await new Promise<void>((resolve) => proxy.close(() => resolve()));
  // Retain broker state as evidence, and stop the exact broker this fixture owns.
  await fixture.close();
}
console.log("native issuance startup smoke passed");
emitSentinel({ passed: cells(), failed: 0 });
