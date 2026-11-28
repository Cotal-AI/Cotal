/**
 * The artifacts verbs end to end, against a real nats-server with real minted credentials and the real
 * delivery daemon serving `artifacts` (A1, checkpoint 2; plan sections 5 and 6).
 *
 *  - put, publish a reference with `multicastWithAck`, confirm-attach on the acknowledged sequence, then a
 *    reader on the channel fetches the bytes and the client verifies the digest;
 *  - fetch runs the read gate first: a peer who may not read the channel gets the gate's refusal for a
 *    digest that exists and for one that does not, byte for byte (S7);
 *  - a reader of the channel asking for a digest nobody attached there gets `unknown digest`;
 *  - every confirm-attach refusal is the same collapsed tuple with no details, across probe shapes: no
 *    such sequence, someone else's post, another channel, a post that does not reference the digest,
 *    and a caller with no possession (S6);
 *  - a repeated confirm leaves the row and its expiry unchanged;
 *  - put refuses before staging past the artifact cap, and a chunk out of order kills the upload;
 *  - the sweep: an unpinned attachment past its expiry turns into `artifact expired` for the next fetch;
 *    a commit with no live attachment and a lapsed reservation is reclaimed (meta and chunks purged,
 *    possession gone), emits `artifact.unconfirmed-commit` once, and a re-put after that needs a new
 *    commit: the old post can no longer be confirmed by the old possession;
 *  - pin clears the expiry, and a pinned attachment survives a sweep past its old expiry;
 *  - S10: a direct get whose body names a sequence (not a subject) yields nothing on the artifact-data
 *    credential.
 *
 * The sweep is driven by calling `sweepOnce` on the daemon's own sweeper credential with a clock moved
 * forward, so lifetimes of days are tested in seconds without touching the daemon's timer.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  ARTIFACT_ATTACHMENT_TTL_MS, ARTIFACT_MAX_BYTES, ARTIFACT_RESERVATION_TTL_MS, ARTIFACTS_CAPABILITY, ARTIFACTS_ENDPOINT,
  ARTIFACTS_CONFIRM_ATTACH_COMMAND, ARTIFACTS_FETCH_BEGIN_COMMAND, ARTIFACTS_PUT_BEGIN_COMMAND, ARTIFACTS_PUT_CHUNK_COMMAND,
  artifactAttachBucket, artifactBucket, artifactPossessBucket, artifactReserveBucket, composeSpaceAuth, confirmAttach,
  CotalEndpoint, createBrokerAuth, createSpaceAccountAuth, DEV_OWNER, fetchArtifact, idFromCreds, isReachable,
  listArtifacts, mintConnectionEvictorCreds, mintCreds, mintLifecycleUid, mintMembershipObserverCreds, newIdentity,
  objectStoreStream, pinArtifact, provisionAgentDurables, putArtifact, serverConfig, setupSpaceStreams, fitPutChunk, EP_REQUEST_HEADER_ALLOWANCE, type SecretStore,
} from "@cotal-ai/core";
import {
  ARTIFACT_SWEEPER_CREDS_KIND, DAEMON_ENDPOINT_BOOTSTRAPS, bootstrapDaemonEndpoint, connectionEvictorCredsKey, daemonEndpointKey,
  deliveryCredsKey, membershipObserverCredsKey, membershipRwCredsKey, ARTIFACT_DATA_CREDS_KIND,
} from "@cotal-ai/workspace";
import { SMOKE_BROKER_TOKEN, createSuite, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { startDeliveryService, type DeliveryServiceHandle } from "../src/index.js";
import { sweepOnce, UNCONFIRMED_COMMIT_EVENT } from "../src/artifact-sweep.js";
import { DigestLocks } from "../src/artifact-verbs.js";
import { metaSubject } from "../src/artifact-objects.js";
import { pickFreePort } from "./_free-port.js";

const EXPECTED_CELLS = 27;
const { check, finish, passed, failed } = createSuite();

class MemoryStore implements SecretStore {
  readonly values = new Map<string, string>();
  constructor(readonly identity: { kind: "injected"; coordinate: string }) {}
  async get(k: string) { return this.values.get(k); }
  async put(k: string, v: string) { this.values.set(k, v); }
  async create(k: string, v: string) { if (this.values.has(k)) return false; this.values.set(k, v); return true; }
  async delete(k: string) { this.values.delete(k); }
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha = (b: Uint8Array) => `sha256:${createHash("sha256").update(b).digest("hex")}`;
const dial = async (servers: string, creds: string): Promise<NatsConnection> =>
  connect({ servers, authenticator: credsAuthenticator(new TextEncoder().encode(creds)), inboxPrefix: `_INBOX_${idFromCreds(creds)}`, reconnect: false });
/** The serialized error of a refused call, or "ok". */
const refusal = async (p: Promise<unknown>): Promise<string> => p.then(() => "ok", (e: { code?: string; message?: string; outcome?: string; details?: unknown }) =>
  JSON.stringify({ code: e.code, message: e.message, outcome: e.outcome, ...(e.details !== undefined ? { details: e.details } : {}) }));

const port = await pickFreePort();
const servers = `nats://127.0.0.1:${port}`;
const broker = await createBrokerAuth("artifacts-verbs");
const space = `artverbs-${Date.now()}`;
const account = await createSpaceAccountAuth(broker, space);
const auth = composeSpaceAuth(broker, account);
const brokerDir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const confPath = join(brokerDir, "server.conf");
writeFileSync(confPath, serverConfig(broker, [account], { transport: { kind: "plaintext" }, port, storeDir: join(brokerDir, "js") }));
let nats = spawn("nats-server", ["-c", confPath], { stdio: "ignore" });
let release = teardownOnSignal(nats, brokerDir);
let handle: DeliveryServiceHandle | undefined;
const endpoints: CotalEndpoint[] = [];
const conns: NatsConnection[] = [];
const events: string[] = [];

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(servers); if (!up) await wait(200); }
  if (!up) throw new Error(`nats-server did not come up on ${port}`);
  const provisionerId = newIdentity();
  const provisioner = await mintCreds(auth, provisionerId, "provisioner");
  await setupSpaceStreams({ servers, space, creds: provisioner });
  const provisionerEp = new CotalEndpoint({ space, servers, creds: provisioner, channels: [], consume: false, registerPresence: false, watchPresence: false,
    card: { id: provisionerId.id, name: "provisioner", role: "provisioner", kind: "agent" } });
  provisionerEp.on("error", () => {});
  endpoints.push(provisionerEp);
  await provisionerEp.start();
  const store = new MemoryStore({ kind: "injected", coordinate: `memory:${space}` });
  const composition = { injected: true as const };
  await store.put(deliveryCredsKey(space, composition), await mintCreds(auth, newIdentity(), "delivery"));
  await store.put(membershipObserverCredsKey(space, composition), await mintMembershipObserverCreds(auth, newIdentity()));
  await store.put(membershipRwCredsKey(space, composition), await mintCreds(auth, newIdentity(), "membership-rw"));
  await store.put(connectionEvictorCredsKey(space, composition), await mintConnectionEvictorCreds(auth, newIdentity()));
  handle = await startDeliveryService({
    context: { accountPublicKey: account.account.pub, lifecycleUid: "artverbs-ctx" },
    space, servers, store, storeIdentity: store.identity, stateDir: join(brokerDir, "state"), endpoints: [ARTIFACTS_ENDPOINT],
  });
  await bootstrapDaemonEndpoint({ auth, servers, space, store, log: () => {} }, DAEMON_ENDPOINT_BOOTSTRAPS[ARTIFACTS_ENDPOINT]!());

  const channel = "work.files", other = "work.other";
  const agentOf = async (actor: string, read: string[], write: string[]) => {
    const uid = mintLifecycleUid();
    const principal = { owner: DEV_OWNER, actor };
    await provisionAgentDurables(provisionerEp, { ...principal, lifecycleUid: uid }, { subscribe: [], allowSubscribe: read });
    const id = newIdentity();
    const creds = await mintCreds(auth, id, "agent", { principal, lifecycleUid: uid, allowSubscribe: read, allowPublish: write, capabilities: [ARTIFACTS_CAPABILITY] });
    const ep = new CotalEndpoint({ space, servers, creds, lifecycleUid: uid, channels: [], allowSubscribe: read, watchChannels: false, watchPresence: false, registerPresence: false,
      card: { id: id.id, owner: DEV_OWNER, actor, name: actor, kind: "agent" } });
    ep.on("error", () => {});
    endpoints.push(ep);
    await ep.start();
    return ep;
  };
  const alice = await agentOf("alice", [channel, other], [channel, other]);
  const bob = await agentOf("bob", [channel], [channel]);
  const eve = await agentOf("eve", ["elsewhere"], ["elsewhere"]);

  // ---- put, publish, confirm, fetch ----
  const bytes = new Uint8Array(300_000).map((_, i) => (i * 31) % 251);
  const digest = sha(bytes);
  const put = await putArtifact(alice, bytes, { name: "report.bin", mediaType: "application/octet-stream" });
  check("putArtifact commits the bytes and the daemon returns the digest it hashed", put.digest === digest && put.size === bytes.byteLength, put);
  const part = { kind: "artifact" as const, name: "report.bin", mediaType: "application/octet-stream", digest, size: bytes.byteLength };
  const posted = await alice.multicastWithAck("here it is", { channel, parts: [{ kind: "text", text: "here it is" }, part] });
  check("multicastWithAck returns the chat sequence the broker acknowledged", Number.isSafeInteger(posted.seq) && posted.seq > 0 && posted.duplicate === false, posted);
  await confirmAttach(alice, { digest, channel, seq: posted.seq });
  const listed = await listArtifacts(bob, { channel });
  check("after confirm-attach the artifact is listed in the channel", listed.rows.length === 1 && listed.rows[0]!.digest === digest, listed);
  const fetched = await fetchArtifact(bob, digest, channel);
  check("a reader of the channel fetches the bytes and the client verifies the digest", sha(fetched.bytes) === digest && fetched.name === "report.bin", { size: fetched.bytes.byteLength });

  // ---- E21: each put-chunk is sized inside its own attempt, against that attempt's frame ----
  // The measuring function every attempt runs, on stated budgets over a REAL frame: the actual
  // put-chunk request this agent's attempt would send (route, bind, caller, nonce, deadline).
  const frames: { seq: number; frame: (raw: number) => number }[] = [];
  const probeId = "a".repeat(32);
  for (const seq of [9, 10]) {
    await alice.invokeService(ARTIFACTS_ENDPOINT, ARTIFACTS_PUT_CHUNK_COMMAND, { uploadId: probeId, seq, data: "AA==" }, {
      fitArgs: (measure) => { frames.push({ seq, frame: (raw) => measure({ uploadId: probeId, seq, data: Buffer.alloc(raw).toString("base64") }) }); return { uploadId: probeId, seq, data: "AA==" }; },
    }).catch(() => undefined);
  }
  const f9 = frames.find((f) => f.seq === 9)!.frame, f10 = frames.find((f) => f.seq === 10)!.frame;
  const budget = f9(3000);
  const fit9 = fitPutChunk(f9, budget, 1 << 20), fit10 = fitPutChunk(f10, budget, 1 << 20);
  check("the attempt's own frame grows a digit from seq 9 to 10, and the fit at the same budget is strictly smaller",
    f10(fit9) === f9(fit9) + 1 && fit10 < fit9 && f9(fit9) <= budget && f10(fit10) <= budget && f10(fit10 + 1) > budget, { fit9, fit10, budget });
  let floor = "";
  try { fitPutChunk(f9, f9(1) - 1, 1 << 20); } catch (e) { floor = `${(e as { code?: string }).code}/${(e as { outcome?: string }).outcome}: ${(e as Error).message}`; }
  check("below the request floor the measuring function refuses before any publish, not-executed, naming the limit",
    /^resource-exhausted\/not-executed: put-chunk: the broker's message limit leaves \d+ bytes for a request and one raw byte/.test(floor), floor);

  // ---- the read gate first (S7) ----
  const unknownDigest = sha(new Uint8Array([9, 9, 9]));
  const gateKnown = await refusal(eve.invokeService(ARTIFACTS_ENDPOINT, ARTIFACTS_FETCH_BEGIN_COMMAND, { digest, channel }).then((r) => { if (!r.reply.ok) throw r.reply.error; }));
  const gateUnknown = await refusal(eve.invokeService(ARTIFACTS_ENDPOINT, ARTIFACTS_FETCH_BEGIN_COMMAND, { digest: unknownDigest, channel }).then((r) => { if (!r.reply.ok) throw r.reply.error; }));
  check("a peer who may not read the channel gets the same gate refusal for an existing and a missing digest",
    gateKnown === gateUnknown && /not authorized for that channel/.test(gateKnown), { gateKnown, gateUnknown });
  const unknown = await refusal(fetchArtifact(bob, unknownDigest, channel));
  check("a reader asking for a digest nobody attached in the channel gets unknown digest", /unknown digest/.test(unknown), unknown);

  // ---- confirm-attach collapses every refusal (S6) ----
  const confirmRaw = (ep: CotalEndpoint, args: Record<string, unknown>) =>
    refusal(ep.invokeService(ARTIFACTS_ENDPOINT, ARTIFACTS_CONFIRM_ATTACH_COMMAND, args).then((r) => { if (!r.reply.ok) throw r.reply.error; }));
  const noRef = await alice.multicastWithAck("no reference here", { channel });
  const onOther = await alice.multicastWithAck("on another channel", { channel: other, parts: [part] });
  const probes = {
    noSuchSeq: await confirmRaw(alice, { digest, channel, seq: 9_999_999 }),
    notYourPost: await confirmRaw(bob, { digest, channel, seq: posted.seq }),
    wrongChannel: await confirmRaw(alice, { digest, channel, seq: onOther.seq }),
    noReference: await confirmRaw(alice, { digest, channel, seq: noRef.seq }),
  };
  const bobPost = await bob.multicastWithAck("i did not upload it", { channel, parts: [part] });
  const noPossession = await confirmRaw(bob, { digest, channel, seq: bobPost.seq });
  const shapes = [...Object.values(probes), noPossession];
  const expected = JSON.stringify({ code: "permission-denied", message: "confirm-attach: not authorized for that artifact", outcome: "not-executed" });
  check("every confirm-attach refusal is one collapsed tuple with no details, across five probe shapes",
    shapes.every((s) => s === expected), { ...probes, noPossession });
  const attachKvData = await new Kvm(await dial(servers, (await store.get(daemonEndpointKey(space, ARTIFACTS_ENDPOINT, ARTIFACT_DATA_CREDS_KIND)))!)).open(artifactAttachBucket(space));
  const before = (await attachKvData.get(`${channel}.${digest.slice(7)}`))!;
  await confirmAttach(alice, { digest, channel, seq: posted.seq });
  const after = (await attachKvData.get(`${channel}.${digest.slice(7)}`))!;
  check("a repeated confirm leaves the attachment row and its expiry unchanged", before.revision === after.revision, { before: before.revision, after: after.revision });

  // ---- put bounds, on agents of their own so their staged uploads block no later put ----
  const carol = await agentOf("carol", [channel], [channel]);
  const begin = (ep: CotalEndpoint, size: number, d: string) =>
    refusal(ep.invokeService(ARTIFACTS_ENDPOINT, ARTIFACTS_PUT_BEGIN_COMMAND, { name: "x", mediaType: "x/y", size, digest: d }).then((r) => { if (!r.reply.ok) throw r.reply.error; }));
  const firstHalf = await begin(carol, ARTIFACT_MAX_BYTES, unknownDigest);
  const secondHalf = await begin(carol, ARTIFACT_MAX_BYTES, unknownDigest);
  const tooBig = await begin(carol, 1, unknownDigest);
  check("put-begin refuses past the staged-bytes bound before staging anything",
    firstHalf === "ok" && secondHalf === "ok" && /resource-exhausted/.test(tooBig) && /not-executed/.test(tooBig), { firstHalf, secondHalf, tooBig });
  const dave = await agentOf("dave", [channel], [channel]);
  const begun = await dave.invokeService(ARTIFACTS_ENDPOINT, ARTIFACTS_PUT_BEGIN_COMMAND, { name: "y", mediaType: "x/y", size: 4, digest: sha(new Uint8Array([1, 2, 3, 4])) });
  const uploadId = (begun.reply.data as { uploadId: string }).uploadId;
  const outOfOrder = await refusal(dave.invokeService(ARTIFACTS_ENDPOINT, ARTIFACTS_PUT_CHUNK_COMMAND, { uploadId, seq: 1, data: "AQID" }).then((r) => { if (!r.reply.ok) throw r.reply.error; }));
  const afterDead = await refusal(dave.invokeService(ARTIFACTS_ENDPOINT, ARTIFACTS_PUT_CHUNK_COMMAND, { uploadId, seq: 0, data: "AQID" }).then((r) => { if (!r.reply.ok) throw r.reply.error; }));
  check("a chunk out of order kills the upload, and the next chunk finds no upload", /the upload is dead/.test(outOfOrder) && /no upload/.test(afterDead), { outOfOrder, afterDead });

  // ---- S10: a sequence-addressed direct get yields nothing on artifact-data ----
  const dataNc = await dial(servers, (await store.get(daemonEndpointKey(space, ARTIFACTS_ENDPOINT, ARTIFACT_DATA_CREDS_KIND)))!);
  conns.push(dataNc);
  let seqRead = "";
  try { await dataNc.request(`$JS.API.DIRECT.GET.${objectStoreStream(artifactBucket(space))}`, JSON.stringify({ seq: 1 }), { timeout: 2000 }); seqRead = "answered"; }
  catch (e) { seqRead = (e as Error).message; }
  check("a body-addressed direct get on the object stream is not authorized for artifact-data (S10)", seqRead !== "answered" && /permission|violation|timeout|no responders/i.test(seqRead), seqRead);

  // ---- pin ----
  await pinArtifact(alice, { digest, channel });
  const pinnedRow = JSON.parse(new TextDecoder().decode((await attachKvData.get(`${channel}.${digest.slice(7)}`))!.value)) as { pinned: boolean };
  check("pin clears the attachment's expiry", pinnedRow.pinned === true, pinnedRow);

  // ---- the sweep, on the daemon's sweeper credential, with the clock moved forward ----
  const sweeperNc = await dial(servers, (await store.get(daemonEndpointKey(space, ARTIFACTS_ENDPOINT, ARTIFACT_SWEEPER_CREDS_KIND)))!);
  conns.push(sweeperNc);
  const kvm = new Kvm(sweeperNc);
  const sweepKv = { attach: await kvm.open(artifactAttachBucket(space)), possess: await kvm.open(artifactPossessBucket(space)), reserve: await kvm.open(artifactReserveBucket(space)) };
  const sweep = (offsetMs: number) => sweepOnce({ space, nc: sweeperNc, kv: sweepKv, locks: new DigestLocks(), fence: () => {}, emit: (e) => events.push(JSON.stringify(e)), now: () => Date.now() + offsetMs });

  // A second artifact, attached and unpinned, and a third, committed and never confirmed.
  const b2 = new Uint8Array([5, 6, 7, 8, 9]), d2 = sha(b2);
  await putArtifact(alice, b2, { name: "two.bin", mediaType: "application/octet-stream" });
  const p2 = await alice.multicastWithAck("two", { channel, parts: [{ ...part, name: "two.bin", digest: d2, size: b2.byteLength }] });
  await confirmAttach(alice, { digest: d2, channel, seq: p2.seq });
  const b3 = new Uint8Array([1, 1, 2, 3, 5, 8]), d3 = sha(b3);
  await putArtifact(bob, b3, { name: "three.bin", mediaType: "application/octet-stream" });
  const p3 = await bob.multicastWithAck("three", { channel, parts: [{ ...part, name: "three.bin", digest: d3, size: b3.byteLength }] });

  const r1 = await sweep(ARTIFACT_ATTACHMENT_TTL_MS + 60_000);
  const expired = await refusal(fetchArtifact(bob, d2, channel));
  check("an unpinned attachment past its expiry is tombstoned and the next fetch says artifact expired", r1.tombstoned >= 1 && /artifact expired/.test(expired), { r1, expired });
  const d2meta = (await (await jetstreamManager(sweeperNc, { checkAPI: false })).streams.info(objectStoreStream(artifactBucket(space)), { subjects_filter: metaSubject(space, d2) })).state.subjects ?? {};
  check("the tombstoned artifact's bytes are reclaimed in the same sweep: a tombstone holds nothing", Object.keys(d2meta).length === 0, d2meta);
  const stillPinned = await fetchArtifact(bob, digest, channel);
  check("a pinned attachment survives a sweep past its old expiry", sha(stillPinned.bytes) === digest);
  check("the sweep emits artifact.unconfirmed-commit once, for the finished commit whose confirm never came",
    r1.unconfirmedCommits === 1 && events.length === 1 && JSON.parse(events[0]!).event === UNCONFIRMED_COMMIT_EVENT && JSON.parse(events[0]!).digest === d3, { r1, events });
  check("a digest with no live attachment and a lapsed reservation is reclaimed", r1.digestsReclaimed >= 1, r1);
  const jsm = await jetstreamManager(sweeperNc, { checkAPI: false });
  const metaLeft = (await jsm.streams.info(objectStoreStream(artifactBucket(space)), { subjects_filter: metaSubject(space, d3) })).state.subjects ?? {};
  check("the reclaimed digest's meta is purged from the object stream", Object.keys(metaLeft).length === 0, metaLeft);
  const lateConfirm = await confirmRaw(bob, { digest: d3, channel, seq: p3.seq });
  check("after GC the old post cannot be confirmed: possession died with the blob", lateConfirm === expected, lateConfirm);
  const r2 = await sweep(ARTIFACT_ATTACHMENT_TTL_MS + ARTIFACT_RESERVATION_TTL_MS + 120_000);
  check("a second sweep emits no second unconfirmed-commit event", r2.unconfirmedCommits === 0 && events.length === 1, { r2, events });
  const reput = await putArtifact(bob, b3, { name: "three.bin", mediaType: "application/octet-stream" });
  const p3b = await bob.multicastWithAck("three again", { channel, parts: [{ ...part, name: "three.bin", digest: d3, size: b3.byteLength }] });
  await confirmAttach(bob, { digest: d3, channel, seq: p3b.seq });
  const back = await fetchArtifact(alice, d3, channel);
  check("a re-put after GC is a new verified commit that confirms and fetches", reput.digest === d3 && sha(back.bytes) === d3);

  // ---- E23 on a real broker between the transport and storage floors ----
  // Restarted over the same store with a limit that carries a small stored chunk and every request and
  // reply this flow needs, but not one full 64 KiB stored chunk. A tiny artifact is stored and fetched;
  // a large one is refused at put-begin, before any byte is staged, naming the limit.
  const restartWith = async (maxPayload: number) => {
    await release();
    await new Promise((r) => nats.once("exit", r));
    writeFileSync(confPath, serverConfig(broker, [account], { transport: { kind: "plaintext" }, port, storeDir: join(brokerDir, "js"), maxPayload }));
    nats = spawn("nats-server", ["-c", confPath], { stdio: "ignore" });
    release = teardownOnSignal(nats, brokerDir);
    let ok = false;
    for (let i = 0; i < 150 && !ok; i++) { await wait(200); try { ok = alice.maxPayload === maxPayload && bob.maxPayload === maxPayload; } catch { /* still reconnecting */ } }
    // The daemon's own store connections reconnect too; give them their own moment.
    await wait(2_000);
    return ok;
  };
  const mid = 48 * 1024;
  const midUp = await restartWith(mid);
  const tinyBytes = new Uint8Array(500).map((_, i) => (i * 7) % 251), tinyDigest = sha(tinyBytes);
  const tinyPut = await putArtifact(alice, tinyBytes, { name: "tiny.bin", mediaType: "application/octet-stream" }).then((r) => r.digest, (e: Error) => `!${e.message}`);
  const tinyPost = await alice.multicastWithAck("tiny", { channel, parts: [{ ...part, name: "tiny.bin", digest: tinyDigest, size: tinyBytes.byteLength }] });
  await confirmAttach(alice, { digest: tinyDigest, channel, seq: tinyPost.seq });
  const tinyBack = await fetchArtifact(bob, tinyDigest, channel).then((r) => sha(r.bytes), (e: Error) => `!${e.message}`);
  check("on a broker between the transport and storage floors, a tiny artifact is stored, confirmed and fetched",
    midUp && tinyPut === tinyDigest && tinyBack === tinyDigest, { midUp, tinyPut, tinyBack });
  const big = new Uint8Array(100_000).map((_, i) => (i * 13) % 251);
  const bigRefusal = await refusal(alice.invokeService(ARTIFACTS_ENDPOINT, ARTIFACTS_PUT_BEGIN_COMMAND, { name: "big.bin", mediaType: "x/y", size: big.byteLength, digest: sha(big) })
    .then((r) => { if (!r.reply.ok) throw r.reply.error; }));
  check("on that broker a large artifact is refused at put-begin, resource-exhausted, not-executed, naming the limit and what it needs",
    /"code":"resource-exhausted"/.test(bigRefusal) && /not-executed/.test(bigRefusal)
      && new RegExp(`payload limit is too small for this artifact: its max_payload is ${mid} bytes, and storing ${big.byteLength} bytes needs at least`).test(bigRefusal), bigRefusal);

  // ---- E21 on a real broker that is too small: restarted over the same store with a lower limit ----
  // A caller's describe is cached per endpoint and kept across a reconnect (endpoint-control-plane.ts
  // clears it only on refresh, a permission recovery, a currency split or a registry listing), and each
  // attempt reads the connection's CURRENT max_payload. So alice's next put-chunk, after the broker
  // comes back with a limit below one raw byte of that request, meets the request floor for real.
  const low = f9(1) + EP_REQUEST_HEADER_ALLOWANCE - 64;
  const reconnected = await restartWith(low);
  let lowFloor = "";
  const lowStarted = Date.now();
  try {
    await alice.invokeService(ARTIFACTS_ENDPOINT, ARTIFACTS_PUT_CHUNK_COMMAND, { uploadId: probeId, seq: 0, data: "AA==" }, {
      fitArgs: (measure, budget) => { fitPutChunk((raw) => measure({ uploadId: probeId, seq: 0, data: Buffer.alloc(raw).toString("base64") }), budget, 1000); return {}; },
    });
  } catch (e) { lowFloor = `${(e as { code?: string }).code}/${(e as { outcome?: string }).outcome}: ${(e as Error).message}`; }
  check("after the broker restarts with a lower limit, a put-chunk on the describe the caller already holds refuses before any publish, not-executed, naming the limit",
    reconnected && /^resource-exhausted\/not-executed: put-chunk: the broker's message limit leaves \d+ bytes/.test(lowFloor) && Date.now() - lowStarted < 5_000, { reconnected, low, lowFloor });
  // A caller that must describe now: the reply cannot be published under this limit, and the caller
  // gets a named refusal inside its deadline, not a hang, a bare timeout or a retry loop.
  let tooSmall = "";
  const describeStarted = Date.now();
  try { await alice.describeService(ARTIFACTS_ENDPOINT, { refresh: true, deadlineMs: 20_000 }); tooSmall = "described"; }
  catch (e) { tooSmall = `${(e as { code?: string }).code}: ${(e as Error).message}`; }
  const describeMs = Date.now() - describeStarted;
  check("on a broker whose limit is below the describe reply, the caller gets resource-exhausted naming the payload limit, inside its deadline",
    /^resource-exhausted: describe\(artifacts\) failed: the broker's payload limit is too small: the serialized reply is \d+ bytes and the broker's max_payload is \d+/.test(tooSmall) && describeMs < 20_000, { tooSmall, describeMs });
} catch (e) {
  check("the cell ran to completion", false, (e as Error).stack ?? String(e));
} finally {
  for (const ep of endpoints) await ep.stop().catch(() => {});
  for (const nc of conns) await nc.close().catch(() => {});
  await handle?.close().catch(() => {});
  await release();
}
finish();
if (passed() + failed() !== EXPECTED_CELLS) {
  console.error(`expected ${EXPECTED_CELLS} cells, ran ${passed() + failed()}`);
  process.exitCode = 1;
}
