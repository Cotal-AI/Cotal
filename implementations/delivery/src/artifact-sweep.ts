/**
 * The artifacts sweep (A1, plan section 6). Runs on the `artifact-sweeper` connection of the lease
 * holder only, every pass under the per-digest lock the request path also takes, and re-checks the serve
 * fence before every write. Each step is a delete keyed by digest, so a crash between any two is
 * finished by the next pass.
 *
 *  1. An attachment past `expiresAt` and not pinned becomes a tombstone (`state: expired`), so the next
 *     fetch says `artifact expired`; a tombstone 14 days past its own `expiresAt` is deleted, channel row
 *     first, then its index row (S19).
 *  2. A reservation past its deadline is deleted. It emits `artifact.unconfirmed-commit` only when that
 *     principal's possession row carries the same `reservationId` (S20): the commit finished and its
 *     own confirm never arrived.
 *  3 and 4. A digest found in the object stream, or with possession rows, that has no live attachment
 *     and no live reservation, is reclaimed: its possession rows, then its meta subject, then its chunk
 *     subjects. Absence is read by two completeness-proven scans under the lock: the digest index
 *     `=d.<digestToken>.>` and the reservation family `<digestToken>.>`.
 *
 * The sweeper reads no object bytes and publishes nothing to the object store: the object deletes are
 * filtered purges by subject, and the object inventory is `STREAM.INFO` with a subjects filter.
 */
import { jetstreamManager, type JetStreamManager } from "@nats-io/jetstream";
import type { KV } from "@nats-io/kv";
import type { NatsConnection } from "@nats-io/transport-node";
import { ARTIFACT_ATTACHMENT_TTL_MS, artifactBucket, liveKvEntries, objectStoreStream } from "@cotal-ai/core";
import { attachmentIndexKey, attachmentKey, digestIndexFilter, digestOfToken, digestPrincipalFilter, indexKeyChannel, isIndexKey, parseAttachmentKey } from "./artifact-keys.js";
import { chunkFilter, digestOfChunkSubject, digestOfMetaSubject, metaSubject } from "./artifact-objects.js";
import type { AttachmentRow, PossessionRow, ReservationRow } from "./artifact-index.js";
import type { DigestLocks } from "./artifact-verbs.js";

/** The audit event a lapsed reservation of a finished commit emits. */
export const UNCONFIRMED_COMMIT_EVENT = "artifact.unconfirmed-commit";

export interface SweepDeps {
  space: string;
  nc: NatsConnection;
  kv: { attach: KV; possess: KV; reserve: KV };
  locks: DigestLocks;
  /** Throws when the serving generation this sweep started under has ended. */
  fence: (what: string) => void;
  /** One `artifact.unconfirmed-commit` event. */
  emit: (event: { event: typeof UNCONFIRMED_COMMIT_EVENT; digest: string; principal: string; lifecycleUid: string }) => void;
  now?: () => number;
}

export interface SweepReport {
  tombstoned: number;
  tombstonesDeleted: number;
  reservationsDeleted: number;
  unconfirmedCommits: number;
  digestsReclaimed: number;
}

const enc = new TextEncoder();
const json = <T>(e: { json<U>(): U }): T | undefined => { try { return e.json<T>(); } catch { return undefined; } };

/** One key's live entry, by a completeness-proven scan filtered to exactly that key. The sweeper holds
 *  no `STREAM.MSG.GET` (plan section 1), so every point read here is an exact-key ordered scan. */
async function liveOne(kv: KV, key: string): Promise<{ value: Uint8Array; revision: number; json<U>(): U } | undefined> {
  const hits = (await liveKvEntries(kv, key)).filter((e) => e.key === key);
  return hits[0];
}

/** The digest a possession or reservation key names, and its principal and lifecycle. */
function splitPrincipalKey(key: string): { digest: string; principal: string; lifecycleUid: string } | undefined {
  const parts = key.split(".");
  if (parts.length !== 4) return undefined;
  try { return { digest: digestOfToken(parts[0]!), principal: `${parts[1]}.${parts[2]}`, lifecycleUid: parts[3]! }; }
  catch { return undefined; }
}

/** One sweep, all four passes. */
export async function sweepOnce(deps: SweepDeps): Promise<SweepReport> {
  const now = deps.now?.() ?? Date.now();
  const report: SweepReport = { tombstoned: 0, tombstonesDeleted: 0, reservationsDeleted: 0, unconfirmedCommits: 0, digestsReclaimed: 0 };
  const jsm = await jetstreamManager(deps.nc, { checkAPI: false });

  // Pass 1: lapse attachments, and delete old tombstones.
  for (const e of await liveKvEntries(deps.kv.attach)) {
    if (isIndexKey(e.key)) continue;
    const row = json<AttachmentRow>(e);
    if (row === undefined) continue;
    let channel: string, digest: string;
    try { ({ channel, digest } = parseAttachmentKey(e.key)); } catch { continue; }
    await deps.locks.run(digest, async () => {
      const cur = await liveOne(deps.kv.attach, e.key);
      if (cur === undefined) return;
      const live = json<AttachmentRow>(cur);
      if (live === undefined) return;
      if (live.state === "attached" && !live.pinned && live.expiresAt <= now) {
        // Tombstone first, then drop its index row (plan obligation 1, S19): an expired row is not a
        // live attachment, so its bytes are reclaimed on schedule while fetch still says `artifact expired`.
        deps.fence("the attachment tombstone");
        await deps.kv.attach.update(e.key, enc.encode(JSON.stringify({ ...live, state: "expired", expiresAt: now + ARTIFACT_ATTACHMENT_TTL_MS })), cur.revision);
        await deps.kv.attach.delete(attachmentIndexKey(digest, channel));
        report.tombstoned++;
      } else if (live.state === "expired" && live.expiresAt <= now) {
        deps.fence("the tombstone delete");
        await deps.kv.attach.delete(e.key);
        await deps.kv.attach.delete(attachmentIndexKey(digest, channel));
        report.tombstonesDeleted++;
      }
    });
  }

  // Pass 2: lapsed reservations.
  for (const e of await liveKvEntries(deps.kv.reserve)) {
    const k = splitPrincipalKey(e.key);
    const row = json<ReservationRow>(e);
    if (k === undefined || row === undefined || row.deadline > now) continue;
    await deps.locks.run(k.digest, async () => {
      const cur = await liveOne(deps.kv.reserve, e.key);
      if (cur === undefined) return;
      const live = json<ReservationRow>(cur);
      if (live === undefined || live.deadline > now) return;
      const possession = await liveOne(deps.kv.possess, e.key);
      const held = possession !== undefined ? json<PossessionRow>(possession) : undefined;
      deps.fence("the reservation delete");
      await deps.kv.reserve.delete(e.key);
      report.reservationsDeleted++;
      if (held?.reservationId === live.reservationId) {
        deps.emit({ event: UNCONFIRMED_COMMIT_EVENT, digest: k.digest, principal: k.principal, lifecycleUid: k.lifecycleUid });
        report.unconfirmedCommits++;
      }
    });
  }

  // Passes 3 and 4: every digest anything names, reclaimed when nothing live holds it.
  const candidates = new Set<string>();
  for (const e of await liveKvEntries(deps.kv.possess)) { const k = splitPrincipalKey(e.key); if (k) candidates.add(k.digest); }
  for (const d of await objectDigests(jsm, deps.space)) candidates.add(d);
  for (const digest of candidates) {
    await deps.locks.run(digest, async () => {
      const attached = await liveKvEntries(deps.kv.attach, digestIndexFilter(digest));
      for (const idx of attached) {
        // An index row whose channel row is not live is an orphan (S19): delete it, then judge again.
        let channel: string;
        try { channel = indexKeyChannel(digest, idx.key); } catch { continue; }
        const row = await liveOne(deps.kv.attach, attachmentKey(channel, digest));
        const live = row !== undefined ? json<AttachmentRow>(row) : undefined;
        // An expired tombstone holds nothing: only an `attached` row keeps the bytes.
        if (live === undefined || live.state !== "attached") {
          deps.fence("the orphan index delete");
          await deps.kv.attach.delete(idx.key);
        } else return;
      }
      if ((await liveKvEntries(deps.kv.reserve, digestPrincipalFilter(digest))).length > 0) return;
      deps.fence("reclaiming the digest");
      for (const p of await liveKvEntries(deps.kv.possess, digestPrincipalFilter(digest))) await deps.kv.possess.delete(p.key);
      const stream = objectStoreStream(artifactBucket(deps.space));
      await jsm.streams.purge(stream, { filter: metaSubject(deps.space, digest) });
      await jsm.streams.purge(stream, { filter: chunkFilter(deps.space, digest) });
      report.digestsReclaimed++;
    });
  }
  return report;
}

/** Run {@link sweepOnce} every `intervalMs` while `current()` names an installed set and a bound
 *  generation, one sweep at a time. A pass that fails part way is finished by the next one. Returns the
 *  function that stops it. */
export function startSweeps(opts: {
  intervalMs: number;
  current: () => (Omit<SweepDeps, "emit" | "now"> & { emit: SweepDeps["emit"] }) | undefined;
  log: (line: string) => void;
}): () => void {
  let sweeping = false;
  const timer = setInterval(() => {
    const deps = opts.current();
    if (sweeping || deps === undefined) return;
    sweeping = true;
    void sweepOnce(deps)
      .catch((e: unknown) => opts.log(`! artifacts: the sweep stopped part way (${(e as Error).message}); the next pass finishes it`))
      .finally(() => { sweeping = false; });
  }, opts.intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Every digest with a chunk or a meta subject in the object stream, from `STREAM.INFO` subject
 *  counts: names only, no object bytes. */
async function objectDigests(jsm: JetStreamManager, space: string): Promise<string[]> {
  const stream = objectStoreStream(artifactBucket(space));
  const out = new Set<string>();
  const info = await jsm.streams.info(stream, { subjects_filter: `$O.${artifactBucket(space)}.>` });
  for (const subject of Object.keys(info.state.subjects ?? {})) {
    const d = digestOfChunkSubject(space, subject) ?? digestOfMetaSubject(space, subject);
    if (d) out.add(d);
  }
  return [...out];
}
