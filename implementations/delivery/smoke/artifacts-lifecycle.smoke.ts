/**
 * The artifacts lifecycle through the REAL handlers, under ordered interleavings and crash cuts (A1, plan
 * section 6; engineering E17, E18, E20, E22). Real broker, real index buckets and object store, the real
 * `ArtifactVerbs` handlers, the real sweep and a real serve fence (`DaemonEndpointBinder`). The caller
 * fence, read gate and chat read are stubs: they are proven live in `artifacts-verbs` and
 * `artifacts-endpoint`, and this suite is about what happens after them.
 *
 * Interleavings are ordered by barriers inside the real handlers (`hold`), each released only after the
 * cell observed the other side waiting, and each has a control that shows the outcome differs when the
 * protection is absent.
 *
 *  E17  re-puts of the same bytes in other transport framings, and a retry of a commit cut after its
 *       first chunk, leave the stored bytes intact; a chunk subject holding other bytes refuses a commit.
 *  E20  an empty chunk is refused; a committing upload stays charged until its commit settles.
 *  E18  a confirm held across a quiesce writes nothing (not-executed); a commit whose generation ends
 *       after its first write refuses with `unknown`, never `not-executed`; a fetch held across a quiesce
 *       sends no bytes, and fetch-begin refuses after one.
 *  E22  commit vs sweep and confirm vs sweep, each held before its first write, with a control digest
 *       the same sweep reclaims; the next chunk of a fetch begun before a sweep says `artifact expired`;
 *       the collapsed confirm refusals read possession exactly where they must; crash cuts: index-first,
 *       channel-row delete, reservation-only, re-put before possession, chunks only, and between the meta
 *       and chunk purges, each with its pre-repair state shown.
 */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { Kvm, type KV } from "@nats-io/kv";
import {
  ARTIFACT_ATTACHMENT_TTL_MS, ARTIFACT_MAX_STAGED_UPLOADS, ARTIFACT_RESERVATION_TTL_MS, ARTIFACTS_ENDPOINT, artifactAttachBucket,
  artifactBucket, artifactPossessBucket, artifactReserveBucket, artifactsClusterArtifacts, isReachable, objectStoreStream, principalKey,
  setupSpaceStreams, type EpServeContext,
} from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, createSuite, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { ArtifactIndex, type AttachmentRow, type Caller } from "../src/artifact-index.js";
import { ARTIFACT_STORE_CHUNK_BYTES, ArtifactObjects, chunkFilter, chunkSubject, metaSubject, storedChunkCount } from "../src/artifact-objects.js";
import { attachmentIndexKey, attachmentKey, principalDigestKey } from "../src/artifact-keys.js";
import { sweepOnce } from "../src/artifact-sweep.js";
import { ArtifactVerbs, DigestLocks } from "../src/artifact-verbs.js";
import type { ChatEntryForConfirm } from "../src/artifact-chat-read.js";
import { DaemonEndpointBinder, type ServeScope } from "../src/endpoint-bind.js";
import { pickFreePort } from "./_free-port.js";

const EXPECTED_CELLS = 20;
const { check, finish, passed, failed } = createSuite();
const port = await pickFreePort();
const servers = `nats://127.0.0.1:${port}`;
const sd = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const broker = spawn("nats-server", ["-js", "-sd", sd, "-p", String(port), "-a", "127.0.0.1"], { stdio: "ignore" });
const release = teardownOnSignal(broker, sd);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha = (b: Uint8Array) => `sha256:${createHash("sha256").update(b).digest("hex")}`;
const bytesOf = (n: number, seed: number) => new Uint8Array(n).map((_, i) => (i * seed + 7) % 251);
const space = "artlife";
const who = (actor: string, ch: string): Caller => ({ owner: "local", actor, uid: ch.repeat(26) });
const alice = who("alice", "a"), bob = who("bob", "b"), carol = who("carol", "c"), dave = who("dave", "d");
/** The serialized error of a refused call, or "ok". */
const refusal = (p: Promise<unknown>): Promise<string> => p.then(() => "ok", (e: { code?: string; message?: string; outcome?: string }) =>
  JSON.stringify({ code: e.code, message: e.message, outcome: e.outcome }));
let nc: NatsConnection | undefined;

/** Ordered barriers: `arm(point)` makes the next arrival at `point` wait; `reached` resolves when it
 *  arrives, `release` lets it go (or makes it throw, a crash at that point). */
const barriers = new Map<string, { arrived: () => void; gate: Promise<void> }>();
function arm(point: string): { reached: Promise<void>; release: () => void; crash: () => void } {
  let arrived!: () => void, open!: () => void, fail!: (e: Error) => void;
  const reached = new Promise<void>((r) => { arrived = r; });
  const gate = new Promise<void>((r, j) => { open = r; fail = j; });
  barriers.set(point, { arrived, gate });
  return { reached, release: () => open(), crash: () => fail(new Error(`crashed at ${point}`)) };
}
const hold = async (point: string): Promise<void> => {
  const b = barriers.get(point);
  if (b === undefined) return;
  barriers.delete(point);
  b.arrived();
  await b.gate;
};
/** Whether `p` is still pending after `ms`. */
const pendingAfter = async (p: Promise<unknown>, ms: number): Promise<boolean> => {
  let settled = false;
  void p.then(() => { settled = true; }, () => { settled = true; });
  await wait(ms);
  return !settled;
};

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(servers); if (!up) await wait(100); }
  if (!up) throw new Error("broker never came up");
  await setupSpaceStreams({ servers, space });
  nc = await connect({ servers });
  const kvm = new Kvm(nc);
  const kv = { attach: await kvm.open(artifactAttachBucket(space)), possess: await kvm.open(artifactPossessBucket(space)), reserve: await kvm.open(artifactReserveBucket(space)) };
  // The handlers' possession reads are counted (S6), on their own handle.
  let possessionReads = 0;
  const counted = new Proxy(kv.possess, { get: (t, p) => {
    const v = Reflect.get(t, p) as unknown;
    if (p === "get") return (...a: unknown[]) => { possessionReads++; return (v as (...x: unknown[]) => unknown).apply(t, a); };
    return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(t) : v;
  } }) as KV;
  // A reservation write that quiesces right after it lands, armed per cell (E18).
  let afterReservation: (() => Promise<void>) | undefined;
  const reserveHook = new Proxy(kv.reserve, { get: (t, p) => {
    const v = Reflect.get(t, p) as unknown;
    if (p === "put") return async (...a: unknown[]) => { const r = await (v as (...x: unknown[]) => Promise<unknown>).apply(t, a); const f = afterReservation; afterReservation = undefined; await f?.(); return r; };
    return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(t) : v;
  } }) as KV;
  const index = new ArtifactIndex({ attach: kv.attach, possess: counted, reserve: reserveHook });
  const objects = new ArtifactObjects(nc, space);
  const jsm = await jetstreamManager(nc);
  const stream = objectStoreStream(artifactBucket(space));
  const locks = new DigestLocks();
  const events: string[] = [];
  const chat = new Map<number, ChatEntryForConfirm>();
  let chatSeq = 0;
  const post = (c: Caller, channel: string, digests: string[]): number => {
    chat.set(++chatSeq, { subject: { kind: "chat", owner: c.owner, actor: c.actor, sender: principalKey(c.owner, c.actor).key, rest: channel }, artifactDigests: digests });
    return chatSeq;
  };
  const verbs = new ArtifactVerbs({
    space, stores: () => ({ index, objects }), locks,
    fenceCaller: async (c) => ({ owner: c.owner, actor: c.actor, uid: c.uid }),
    mayReadChannel: async () => {},
    readChatEntry: async (seq) => chat.get(seq),
    hold: (point) => hold(point),
  });
  // A real serve fence; generations are made live directly, as a bound candidate's would be.
  const binder = new DaemonEndpointBinder({ space, servers: "nats://127.0.0.1:1", tls: false,
    endpoint: { endpoint: ARTIFACTS_ENDPOINT, cluster: artifactsClusterArtifacts(), defs: () => [] }, log: () => {} });
  const live = (binder as unknown as { live: Set<number> }).live;
  let generation = 0;
  const scope = (): ServeScope => { binder.leaseRegained(); live.add(++generation); return { generation, fence: binder.fence }; };
  let s = scope();
  const ctx = (c: Caller, args: Record<string, unknown>) => ({
    identity: {}, subject: { caller: c }, request: { args },
    replyFits: (data: unknown, ceiling: number) => JSON.stringify({ v: 1, id: "x".repeat(32), ok: true, data }).length <= Math.min(ceiling, 1 << 20),
  }) as unknown as EpServeContext;
  /** Stage `bytes` through the real put-begin and put-chunk, cut in `cuts` (the last size repeats). */
  const stage = async (c: Caller, bytes: Uint8Array, cuts: number[]) => {
    const digest = sha(bytes);
    const { uploadId } = await verbs.putBegin(s)(ctx(c, { name: "f.bin", mediaType: "x/y", size: bytes.byteLength, digest }));
    let off = 0, seq = 0;
    while (off < bytes.byteLength) {
      const n = Math.min(cuts[Math.min(seq, cuts.length - 1)]!, bytes.byteLength - off);
      await verbs.putChunk(s)(ctx(c, { uploadId, seq, data: Buffer.from(bytes.subarray(off, off + n)).toString("base64") }));
      off += n; seq++;
    }
    return { digest, uploadId, commit: () => verbs.putCommit(s)(ctx(c, { uploadId })) };
  };
  const put = async (c: Caller, bytes: Uint8Array, cuts: number[] = [100_000]) => { const st = await stage(c, bytes, cuts); await st.commit(); return st.digest; };
  const confirm = (c: Caller, channel: string, digest: string) => verbs.confirmAttach(s)(ctx(c, { digest, channel, seq: post(c, channel, [digest]) }));
  const fetchAll = async (c: Caller, channel: string, digest: string) => {
    await verbs.fetchBegin(s)(ctx(c, { digest, channel }));
    const parts: Buffer[] = [];
    for (let off = 0; ;) {
      const r = await verbs.fetchChunk(s)(ctx(c, { digest, channel, offset: off }));
      const b = Buffer.from(r.data, "base64");
      parts.push(b); off += b.byteLength;
      if (r.complete) return Buffer.concat(parts);
    }
  };
  const subjects = async (filter: string) => Object.keys((await jsm.streams.info(stream, { subjects_filter: filter })).state.subjects ?? {}).length;
  const metaPresent = async (d: string) => (await subjects(metaSubject(space, d))) > 0;
  const sweep = (offsetMs = 0) => sweepOnce({ space, nc: nc!, kv, locks, fence: () => {}, emit: (e) => events.push(e.digest), now: () => Date.now() + offsetMs, hold: (point, d) => hold(`${point}:${d}`) });
  const lapse = ARTIFACT_RESERVATION_TTL_MS + 60_000;

  // ---- E17: storage framing is independent of how the bytes arrived ----
  {
    const bytes = bytesOf(200_000, 31);
    const d = await put(alice, bytes, [100_000]);
    await confirm(alice, "team.r", d);
    await put(alice, bytes, [50_000]);
    await put(alice, bytes, [128 * 1024, 7_000]);
    const back = await fetchAll(bob, "team.r", d);
    check("re-puts of the same bytes in three transport framings leave the attached bytes intact, in fixed storage chunks",
      sha(back) === d && (await subjects(chunkFilter(space, d))) === storedChunkCount(bytes.byteLength) && (await objects.readMeta(d))?.chunks === storedChunkCount(bytes.byteLength),
      { stored: await subjects(chunkFilter(space, d)), want: storedChunkCount(bytes.byteLength) });
  }
  {
    const bytes = bytesOf(150_000, 17), d = sha(bytes);
    const blocks = [0, 1, 2].map((i) => bytes.subarray(i * ARTIFACT_STORE_CHUNK_BYTES, Math.min(bytes.byteLength, (i + 1) * ARTIFACT_STORE_CHUNK_BYTES)));
    let cut = "";
    try { await objects.write({ digest: d, name: "f", mediaType: "x/y" }, blocks, (what) => { if (what === "chunk 1") throw new Error("crash"); }); } catch (e) { cut = (e as Error).message; }
    const partial = await subjects(chunkFilter(space, d));
    const retried = await put(alice, bytes, [10_000]);
    await confirm(alice, "team.r2", retried);
    const back = await fetchAll(bob, "team.r2", d);
    check("a retry of a commit cut after its first chunk, sent in another framing, completes with exactly the hashed bytes",
      cut === "crash" && partial === 1 && sha(back) === d && (await subjects(chunkFilter(space, d))) === 3, { partial, cut });
  }
  {
    const bytes = bytesOf(70_000, 13), d = sha(bytes);
    await jetstream(nc).publish(chunkSubject(space, d, 0), new Uint8Array([1, 2, 3]));
    const refused = await refusal(put(alice, bytes, [70_000]));
    check("a chunk subject already holding other bytes refuses the commit before any meta record",
      /already holds different bytes/.test(refused) && !(await metaPresent(d)), refused);
  }

  // ---- E20: staging ----
  {
    const { uploadId } = await verbs.putBegin(s)(ctx(dave, { name: "e", mediaType: "x/y", size: 4, digest: sha(new Uint8Array(4)) }));
    const empty = await refusal(verbs.putChunk(s)(ctx(dave, { uploadId, seq: 0, data: "" })));
    const after = await refusal(verbs.putChunk(s)(ctx(dave, { uploadId, seq: 0, data: "AAAAAA==" })));
    check("an empty put-chunk is refused, not-executed, and ends the upload", /carries no byte/.test(empty) && /not-executed/.test(empty) && /no upload/.test(after), { empty, after });
  }
  {
    // C15: a data connection whose broker limit is below one stored chunk refuses at put-begin, before
    // any byte is staged, not at commit. The real handler over a connection reporting that limit.
    const small = new ArtifactObjects({ info: { max_payload: 60_000 } } as unknown as NatsConnection, space);
    const smallVerbs = new ArtifactVerbs({ space, stores: () => ({ index, objects: small }), locks: new DigestLocks(),
      fenceCaller: async (c) => ({ owner: c.owner, actor: c.actor, uid: c.uid }), mayReadChannel: async () => {}, readChatEntry: async () => undefined });
    const refused = await refusal(smallVerbs.putBegin(s)(ctx(dave, { name: "s", mediaType: "x/y", size: 10, digest: sha(bytesOf(10, 7)) })));
    check("on a broker limit below one stored chunk, put-begin refuses before staging, resource-exhausted, not-executed, naming the limit",
      /"code":"resource-exhausted"/.test(refused) && /payload limit is too small: its max_payload is 60000 bytes/.test(refused) && /not-executed/.test(refused)
        && smallVerbs.staging.chargeOf(dave).uploads === 0, refused);
  }
  {
    const first = await stage(carol, bytesOf(1000, 3), [1000]);
    const held = arm("commit-locked");
    const committing = first.commit();
    await held.reached;
    const others: string[] = [];
    for (let i = 1; i < ARTIFACT_MAX_STAGED_UPLOADS; i++) others.push(await refusal(verbs.putBegin(s)(ctx(carol, { name: "o", mediaType: "x/y", size: 10, digest: sha(bytesOf(10, i)) }))));
    const over = await refusal(verbs.putBegin(s)(ctx(carol, { name: "o", mediaType: "x/y", size: 10, digest: sha(bytesOf(10, 99)) })));
    const chargedWhileHeld = verbs.staging.chargeOf(carol);
    held.release();
    await committing;
    const afterSettle = await refusal(verbs.putBegin(s)(ctx(carol, { name: "o", mediaType: "x/y", size: 10, digest: sha(bytesOf(10, 98)) })));
    check("a committing upload stays charged until its commit settles: the bound refuses while it is held, and admits after",
      others.every((o) => o === "ok") && /uploads staged or committing/.test(over) && chargedWhileHeld.uploads === ARTIFACT_MAX_STAGED_UPLOADS && chargedWhileHeld.bytes === 1030 && afterSettle === "ok",
      { others, over, chargedWhileHeld, afterSettle });
  }

  // ---- E18: the serve fence at each write and reply, across a real quiesce ----
  {
    const bytes = bytesOf(5_000, 5);
    const d = await put(bob, bytes);
    const held = arm("confirm-locked");
    const confirming = refusal(confirm(bob, "team.q", d));
    await held.reached;
    await binder.quiesce("the lease is being re-checked");
    held.release();
    const r = await confirming;
    check("a confirm held across a quiesce writes nothing and refuses not-executed",
      /"code":"unavailable"/.test(r) && /not-executed/.test(r) && (await kv.attach.get(attachmentKey("team.q", d))) === null, r);
    s = scope();
  }
  {
    const bytes = bytesOf(5_000, 6), d = sha(bytes);
    const st = await stage(dave, bytes, [5_000]);
    afterReservation = () => binder.quiesce("lost the lease");
    const r = await refusal(st.commit());
    const reservation = await kv.reserve.get(principalDigestKey(d, dave));
    check("a commit whose generation ends after its reservation landed refuses with outcome unknown, never not-executed",
      /"outcome":"unknown"/.test(r) && reservation?.operation === "PUT" && !(await metaPresent(d)), r);
    s = scope();
  }
  {
    const bytes = bytesOf(5_000, 8);
    const d = await put(bob, bytes);
    await confirm(bob, "team.f", d);
    const held = arm("fetch-read");
    const fetching = refusal(verbs.fetchChunk(s)(ctx(bob, { digest: d, channel: "team.f", offset: 0 })));
    await held.reached;
    await binder.quiesce("lost the lease");
    held.release();
    const r = await fetching;
    const begin = await refusal(verbs.fetchBegin(s)(ctx(bob, { digest: d, channel: "team.f" })));
    check("a fetch-chunk held across a quiesce sends no bytes, and fetch-begin refuses after it",
      /unavailable/.test(r) && /not-executed/.test(r) && /unavailable/.test(begin), { r, begin });
    s = scope();
  }

  // ---- E22: interleavings through the real handlers, each held before its first write ----
  {
    // X: bob committed, never confirmed, reservation lapsed; alice re-puts while the sweep arrives.
    // Y: the same state with no re-put: the control the same sweep reclaims.
    const x = bytesOf(3_000, 21), y = bytesOf(3_000, 22);
    const dx = await put(bob, x), dy = await put(bob, y);
    // Bob's meta record's stream sequence: unchanged only if the sweep never purged it. A sweep that did
    // not wait would reclaim dx (bob's reservation lapsed, alice's not yet written) and alice's commit
    // would then write a NEW meta record, so presence alone would not tell the two apart.
    const metaSeq = async () => (await jsm.streams.getMessage(stream, { last_by_subj: metaSubject(space, dx) }).catch(() => null))?.seq;
    const seqBefore = await metaSeq();
    const reput = await stage(alice, x, [3_000]);
    const held = arm("commit-locked");
    const committing = reput.commit();
    await held.reached;
    const sweeping = sweep(lapse);
    const waited = await pendingAfter(sweeping, 300);
    held.release();
    await committing;
    await sweeping;
    check("a sweep arriving while a commit holds the digest (before its first write) waits, then finds its reservation and keeps the very same meta record",
      waited && seqBefore !== undefined && (await metaSeq()) === seqBefore, { waited, seqBefore });
    check("the control digest with no commit in front of it is reclaimed by the same sweep", !(await metaPresent(dy)));
  }
  {
    const z = bytesOf(3_000, 23), w = bytesOf(3_000, 24);
    const dz = await put(bob, z), dw = await put(bob, w);
    const held = arm("confirm-locked");
    const confirming = confirm(bob, "team.z", dz);
    await held.reached;
    const sweeping = sweep(lapse);
    const waited = await pendingAfter(sweeping, 300);
    held.release();
    const confirmed = await refusal(confirming);
    await sweeping;
    check("a sweep arriving while a confirm holds the digest waits; the confirm attaches and the bytes stay, while the unconfirmed control is reclaimed",
      waited && confirmed === "ok" && await metaPresent(dz) && !(await metaPresent(dw)) && sha(await fetchAll(alice, "team.z", dz)) === dz, { waited, confirmed });
  }
  {
    const bytes = bytesOf(300_000, 29);
    const d = await put(bob, bytes);
    await confirm(bob, "team.e", d);
    const first = await verbs.fetchChunk(s)(ctx(alice, { digest: d, channel: "team.e", offset: 0 }));
    const got = Buffer.from(first.data, "base64").byteLength;
    await sweep(ARTIFACT_ATTACHMENT_TTL_MS + 60_000);
    const next = await refusal(verbs.fetchChunk(s)(ctx(alice, { digest: d, channel: "team.e", offset: got })));
    check("the next chunk of a fetch begun before a sweep that expired its attachment says artifact expired",
      got > 0 && !first.complete && /artifact expired/.test(next), { got, next });
  }
  {
    const bytes = bytesOf(2_000, 31), d = await put(alice, bytes);
    const counts: number[] = [];
    const shapes: string[] = [];
    const probe = async (p: () => Promise<unknown>) => { const before = possessionReads; shapes.push(await refusal(p())); counts.push(possessionReads - before); };
    await probe(() => verbs.confirmAttach(s)(ctx(alice, { digest: d, channel: "team.p", seq: 9_999_999 })));
    await probe(() => verbs.confirmAttach(s)(ctx(bob, { digest: d, channel: "team.p", seq: post(alice, "team.p", [d]) })));
    await probe(() => verbs.confirmAttach(s)(ctx(alice, { digest: d, channel: "team.p", seq: post(alice, "team.other", [d]) })));
    await probe(() => verbs.confirmAttach(s)(ctx(alice, { digest: d, channel: "team.p", seq: post(alice, "team.p", []) })));
    await probe(() => verbs.confirmAttach(s)(ctx(carol, { digest: d, channel: "team.p", seq: post(carol, "team.p", [d]) })));
    check("every collapsed confirm refusal is one tuple, and possession is read only on the path that reaches it: 0,0,0,0,1",
      new Set(shapes).size === 1 && /confirm-attach: not authorized for that artifact/.test(shapes[0]!) && JSON.stringify(counts) === "[0,0,0,0,1]", { counts, shapes });
  }

  // ---- E22: crash cuts, each with its pre-repair state shown ----
  const row = (): AttachmentRow => ({ state: "attached", confirmerLifecycleUid: alice.uid, name: "f", mediaType: "x/y", size: 1, createdAt: Date.now(), expiresAt: Date.now() + 60_000, pinned: false });
  const settled = async (bytes: Uint8Array) => { const d = await put(alice, bytes); await kv.reserve.delete(principalDigestKey(d, alice)); return d; };
  {
    const d = await settled(bytesOf(1_000, 41));
    await kv.attach.put(attachmentIndexKey(d, "team.b"), JSON.stringify({ channel: "team.b" }));
    const before = (await kv.attach.get(attachmentIndexKey(d, "team.b")))?.operation === "PUT" && await metaPresent(d) && (await kv.attach.get(attachmentKey("team.b", d))) === null;
    await sweep();
    const idx = await kv.attach.get(attachmentIndexKey(d, "team.b"));
    check("index-first cut: an index row with no channel row holds the bytes until the sweep reconciles it, then they are reclaimed",
      before && (idx === null || idx.operation !== "PUT") && !(await metaPresent(d)));
  }
  {
    const d = await settled(bytesOf(1_000, 42));
    await index.attachIfAbsent("team.c", d, row(), () => {});
    await kv.attach.delete(attachmentKey("team.c", d));
    const before = (await kv.attach.get(attachmentIndexKey(d, "team.c")))?.operation === "PUT" && await metaPresent(d);
    await sweep();
    const idx = await kv.attach.get(attachmentIndexKey(d, "team.c"));
    check("channel-row-delete cut: the stranded index row is reconciled and the bytes reclaimed", before && (idx === null || idx.operation !== "PUT") && !(await metaPresent(d)));
  }
  {
    events.length = 0;
    const bytes = bytesOf(1_000, 43), d = sha(bytes);
    const st = await stage(alice, bytes, [1_000]);
    afterReservation = async () => { live.clear(); };
    await refusal(st.commit());
    s = scope();
    const early = await sweep();
    const reservationKept = (await kv.reserve.get(principalDigestKey(d, alice)))?.operation === "PUT";
    const late = await sweep(lapse);
    check("reservation-only cut: inside its deadline nothing is touched; past it the reservation goes silently",
      reservationKept && early.reservationsDeleted === 0 && late.reservationsDeleted >= 1 && !events.includes(d), { early, late });
  }
  {
    events.length = 0;
    const d = await put(alice, bytesOf(1_000, 44));
    await index.attachIfAbsent("team.d", d, { ...row(), pinned: true }, () => {});
    await kv.reserve.delete(principalDigestKey(d, alice));
    await index.writeReservation(d, alice, { deadline: Date.now() + ARTIFACT_RESERVATION_TTL_MS, reservationId: randomUUID() }, () => {});
    const r = await sweep(lapse);
    check("re-put cut before its possession write: the lapsed reservation emits nothing, the possession row still carries the earlier id",
      !events.includes(d) && r.reservationsDeleted >= 1 && await metaPresent(d), { r, events });
  }
  {
    const bytes = bytesOf(150_000, 45), d = sha(bytes);
    const blocks = [0, 1, 2].map((i) => bytes.subarray(i * ARTIFACT_STORE_CHUNK_BYTES, Math.min(bytes.byteLength, (i + 1) * ARTIFACT_STORE_CHUNK_BYTES)));
    await index.writeReservation(d, alice, { deadline: Date.now() + ARTIFACT_RESERVATION_TTL_MS, reservationId: randomUUID() }, () => {});
    await objects.write({ digest: d, name: "f", mediaType: "x/y" }, blocks, (what) => { if (what === "the meta record") throw new Error("crash"); }).catch(() => undefined);
    const chunksOnly = (await subjects(chunkFilter(space, d))) === 3 && !(await metaPresent(d));
    await sweep();
    const keptInside = (await subjects(chunkFilter(space, d))) === 3;
    await sweep(lapse);
    check("chunks-only cut: chunks with no meta are kept inside the reservation deadline and purged after it",
      chunksOnly && keptInside && (await subjects(chunkFilter(space, d))) === 0);
  }
  {
    const d = await settled(bytesOf(150_000, 46));
    const cut = arm(`between-purges:${d}`);
    const crashing = sweep().catch((e: Error) => e.message);
    await cut.reached;
    cut.crash();
    const crashed = await crashing;
    const between = !(await metaPresent(d)) && (await subjects(chunkFilter(space, d))) === 3;
    await sweep();
    check("a cut between the meta and chunk purges leaves chunks only, and the next sweep purges them",
      /crashed at between-purges/.test(String(crashed)) && between && (await subjects(chunkFilter(space, d))) === 0, { crashed, between });
  }
} catch (e) {
  check("the cell ran to completion", false, (e as Error).stack ?? String(e));
} finally {
  await nc?.close().catch(() => {});
  await release();
}
finish();
if (passed() + failed() !== EXPECTED_CELLS) {
  console.error(`expected ${EXPECTED_CELLS} cells, ran ${passed() + failed()}`);
  process.exitCode = 1;
}
