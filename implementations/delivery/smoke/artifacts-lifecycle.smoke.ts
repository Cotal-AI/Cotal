/**
 * The artifacts lifecycle under held interleavings and crash cuts (A1, plan section 6; the engineering
 * review's E5 and obligation 3). Real broker, real index buckets and object store, the real sweep and the
 * real index layer; the per-digest lock and the clock are held by the cell so each interleaving is
 * ordered, not raced.
 *
 *  1. commit vs sweep: a sweep that arrives while a commit holds the digest lock waits for it, and finds
 *     the commit's reservation, so it reclaims nothing.
 *  2. confirm vs sweep: a sweep held behind a confirm sees the new live attachment and keeps the bytes.
 *  3. crash between the index row and the channel row (index-first): the orphan index row keeps the bytes
 *     until the sweep reconciles it, and then they are reclaimed; the channel row never exists alone.
 *  4. crash between the channel-row delete and the index-row delete (the reverse): the sweep removes the
 *     stranded index row and reclaims the bytes.
 *  5. crash after the reservation and before the possession row: the sweep deletes the reservation
 *     silently (no unconfirmed-commit event), then reclaims the partial objects.
 *  6. a re-put by a principal who already possessed the digest that crashes before its possession write
 *     leaves the old reservation id on the possession row, so its lapse emits nothing.
 */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { ARTIFACT_RESERVATION_TTL_MS, artifactAttachBucket, artifactBucket, artifactPossessBucket, artifactReserveBucket, isReachable, objectStoreStream, setupSpaceStreams } from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, createSuite, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { ArtifactIndex, type AttachmentRow } from "../src/artifact-index.js";
import { ArtifactObjects, metaSubject } from "../src/artifact-objects.js";
import { attachmentIndexKey, attachmentKey } from "../src/artifact-keys.js";
import { sweepOnce, type SweepDeps } from "../src/artifact-sweep.js";
import { DigestLocks } from "../src/artifact-verbs.js";
import { pickFreePort } from "./_free-port.js";

const EXPECTED_CELLS = 8;
const { check, finish, passed, failed } = createSuite();
const port = await pickFreePort();
const servers = `nats://127.0.0.1:${port}`;
const sd = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const broker = spawn("nats-server", ["-js", "-sd", sd, "-p", String(port), "-a", "127.0.0.1"], { stdio: "ignore" });
const release = teardownOnSignal(broker, sd);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha = (b: Uint8Array) => `sha256:${createHash("sha256").update(b).digest("hex")}`;
const space = "artlife";
const alice = { owner: "local", actor: "alice", uid: "a".repeat(26) };
let nc: NatsConnection | undefined;

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(servers); if (!up) await wait(100); }
  if (!up) throw new Error("broker never came up");
  await setupSpaceStreams({ servers, space });
  nc = await connect({ servers });
  const kvm = new Kvm(nc);
  const kv = { attach: await kvm.open(artifactAttachBucket(space)), possess: await kvm.open(artifactPossessBucket(space)), reserve: await kvm.open(artifactReserveBucket(space)) };
  const index = new ArtifactIndex(kv);
  const objects = new ArtifactObjects(nc, space);
  const jsm = await jetstreamManager(nc);
  const locks = new DigestLocks();
  const events: string[] = [];
  const sweep = (offsetMs = 0, l = locks) => sweepOnce({ space, nc: nc!, kv, locks: l, fence: () => {}, emit: (e) => events.push(e.digest), now: () => Date.now() + offsetMs } satisfies SweepDeps);
  const metaPresent = async (d: string) => Object.keys((await jsm.streams.info(objectStoreStream(artifactBucket(space)), { subjects_filter: metaSubject(space, d) })).state.subjects ?? {}).length > 0;
  /** A full commit, in the plan's order, as the handler writes it. */
  const commit = async (bytes: Uint8Array, stopAfter?: "reservation" | "objects") => {
    const digest = sha(bytes), reservationId = randomUUID();
    await index.writeReservation(digest, alice, { deadline: Date.now() + ARTIFACT_RESERVATION_TTL_MS, reservationId });
    if (stopAfter === "reservation") return { digest, reservationId };
    await objects.write({ digest, size: bytes.byteLength, chunks: 1, name: "f", mediaType: "x/y" }, [bytes], () => {});
    if (stopAfter === "objects") return { digest, reservationId };
    await index.writePossession(digest, alice, { size: bytes.byteLength, name: "f", mediaType: "x/y", committedAt: Date.now(), reservationId });
    return { digest, reservationId };
  };
  const row = (): AttachmentRow => ({ state: "attached", confirmerLifecycleUid: alice.uid, name: "f", mediaType: "x/y", size: 1, createdAt: Date.now(), expiresAt: Date.now() + 60_000, pinned: false });

  // 1. commit vs sweep, ordered by holding the lock across the commit.
  {
    const bytes = new Uint8Array([1, 2, 3]);
    let releaseCommit!: () => void;
    const held = new Promise<void>((r) => { releaseCommit = r; });
    const committing = locks.run(sha(bytes), async () => { await commit(bytes); await held; });
    await wait(50);
    const sweeping = sweep();
    await wait(200);
    releaseCommit();
    await committing;
    const r = await sweeping;
    check("a sweep held behind a commit finds its reservation and reclaims nothing", r.digestsReclaimed === 0 && await metaPresent(sha(bytes)), r);
  }

  // 2. confirm vs sweep: the attach lands while the sweep waits; the reservation is consumed by the confirm.
  {
    const bytes = new Uint8Array([4, 5, 6]);
    const { digest } = await commit(bytes);
    let releaseConfirm!: () => void;
    const held = new Promise<void>((r) => { releaseConfirm = r; });
    const confirming = locks.run(digest, async () => {
      await index.attachIfAbsent("team.a", digest, row());
      await index.deleteReservation(digest, alice);
      await held;
    });
    await wait(50);
    const sweeping = sweep();
    await wait(200);
    releaseConfirm();
    await confirming;
    const r = await sweeping;
    check("a sweep held behind a confirm sees the live attachment and keeps the bytes", await metaPresent(digest), r);
  }

  // 3. crash between the index row and the channel row: only the index row exists.
  {
    const bytes = new Uint8Array([7, 8, 9]);
    const { digest } = await commit(bytes);
    await index.deleteReservation(digest, alice);
    await kv.attach.put(attachmentIndexKey(digest, "team.b"), JSON.stringify({ channel: "team.b" }));
    check("after the index-first cut no channel row exists without its index row", (await kv.attach.get(attachmentKey("team.b", digest)))?.operation !== "PUT");
    const r = await sweep();
    const idx = await kv.attach.get(attachmentIndexKey(digest, "team.b"));
    check("the sweep removes the orphan index row and reclaims the bytes it was holding",
      (idx === null || idx.operation !== "PUT") && !(await metaPresent(digest)) && r.digestsReclaimed >= 1, r);
  }

  // 4. crash between the channel-row delete and the index-row delete.
  {
    const bytes = new Uint8Array([10, 11, 12]);
    const { digest } = await commit(bytes);
    await index.deleteReservation(digest, alice);
    await index.attachIfAbsent("team.c", digest, row());
    await kv.attach.delete(attachmentKey("team.c", digest));
    const r = await sweep();
    const idx = await kv.attach.get(attachmentIndexKey(digest, "team.c"));
    check("a stranded index row after the channel-row delete is reconciled and the bytes reclaimed",
      (idx === null || idx.operation !== "PUT") && !(await metaPresent(digest)), r);
  }

  // 5. crash after the reservation, before the possession row (objects written).
  {
    events.length = 0;
    const bytes = new Uint8Array([13, 14, 15]);
    const { digest } = await commit(bytes, "objects");
    const early = await sweep();
    check("a partial commit inside its reservation deadline is not reclaimed", await metaPresent(digest), early);
    const late = await sweep(ARTIFACT_RESERVATION_TTL_MS + 60_000);
    check("past its deadline the crashed commit's reservation is deleted silently and its objects reclaimed",
      !events.includes(digest) && !(await metaPresent(digest)) && late.reservationsDeleted >= 1, { late, events, digest });
  }

  // 6. re-put by an existing possessor that crashes before its possession write.
  {
    events.length = 0;
    const bytes = new Uint8Array([16, 17, 18]);
    const first = await commit(bytes);
    await index.attachIfAbsent("team.d", first.digest, { ...row(), pinned: true });
    await index.deleteReservation(first.digest, alice);
    // The re-put writes a new reservation and crashes before its possession write.
    await index.writeReservation(first.digest, alice, { deadline: Date.now() + ARTIFACT_RESERVATION_TTL_MS, reservationId: randomUUID() });
    const r = await sweep(ARTIFACT_RESERVATION_TTL_MS + 60_000);
    check("a crashed re-put's lapsed reservation emits nothing: the possession row still carries the earlier id",
      !events.includes(first.digest) && r.reservationsDeleted >= 1 && await metaPresent(first.digest), { r, events });
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
