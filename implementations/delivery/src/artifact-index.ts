/**
 * The three artifact index stores as the artifacts service reads and writes them (plan section 4,
 * security S13, S19, S20).
 *
 * Every key comes from `artifact-keys.ts`; this module takes validated digests, channels and callers,
 * never a raw key. Reads are point reads by exact key. The buckets are `allow_direct: false`, so a get
 * on a handle bound by `Kvm.open` is a leader-served `STREAM.MSG.GET` (SPEC 13.12): every read here
 * authorizes an effect, so none may be served by a follower.
 *
 * Rows:
 *  - possession `<digestToken>.<owner>.<actor>.<uid>`: `{size, name, mediaType, committedAt,
 *    reservationId}`, the commit-time metadata of that lifecycle's latest completed commit;
 *  - reservation, same key shape: `{deadline, reservationId}`, written first by every commit attempt;
 *  - attachment `<channel>.<digestToken>`: `{state, confirmerLifecycleUid, name, mediaType, size,
 *    createdAt, expiresAt, pinned}`, and its digest-index row `=d.<digestToken>.<channel>`.
 *
 * Order (S19): an attach writes the index row, then the channel row; a removal deletes the channel row,
 * then the index row. So a LIVE channel row never exists without its index row.
 *
 * Every write takes a `guard` and calls it immediately before that one publish, CAS retries and
 * rollback included, so the serve fence is checked at each actual mutation and never upstream of an
 * await (E18).
 */
import type { KV, KvEntry } from "@nats-io/kv";
import { isCasLoss } from "@cotal-ai/core";
import { attachmentIndexKey, attachmentKey, principalDigestKey } from "./artifact-keys.js";

export interface Caller { owner: string; actor: string; uid: string }

export interface PossessionRow { size: number; name: string; mediaType: string; committedAt: number; reservationId: string }
export interface ReservationRow { deadline: number; reservationId: string }
export interface AttachmentRow {
  state: "attached" | "expired";
  confirmerLifecycleUid: string;
  name: string;
  mediaType: string;
  size: number;
  createdAt: number;
  /** Epoch ms the attachment lapses unless pinned. For an expired tombstone, when it is deleted. */
  expiresAt: number;
  pinned: boolean;
}

const enc = new TextEncoder();
const json = (v: unknown): Uint8Array => enc.encode(JSON.stringify(v));

/** A live value, or `undefined` for an absent key and for a delete or purge marker (a tombstone is
 *  not a row: a deleted possession row read as present once let a confirm through). */
async function live<T>(kv: KV, key: string): Promise<{ value: T; revision: number } | undefined> {
  const e: KvEntry | null = await kv.get(key);
  if (e === null || e.operation !== "PUT") return undefined;
  try { return { value: e.json<T>(), revision: e.revision }; } catch { return undefined; }
}

/** Called immediately before one write; throws to stop it. */
export type WriteGuard = (what: string) => void;

/** The index stores over one `artifact-data` connection's three bound handles. */
export class ArtifactIndex {
  constructor(private readonly kv: { attach: KV; possess: KV; reserve: KV }) {}

  readPossession(digest: string, caller: Caller) {
    return live<PossessionRow>(this.kv.possess, principalDigestKey(digest, caller));
  }
  readReservation(digest: string, caller: Caller) {
    return live<ReservationRow>(this.kv.reserve, principalDigestKey(digest, caller));
  }
  readAttachment(channel: string, digest: string) {
    return live<AttachmentRow>(this.kv.attach, attachmentKey(channel, digest));
  }

  /** The first step of every commit attempt: this attempt's reservation, replacing any earlier one. */
  async writeReservation(digest: string, caller: Caller, row: ReservationRow, guard: WriteGuard): Promise<void> {
    guard("the reservation");
    await this.kv.reserve.put(principalDigestKey(digest, caller), json(row));
  }

  /** The last step of a commit: the possession row carrying this attempt's reservation id. A CAS update
   *  of an existing row on a re-put, a create on a first put; a lost race re-reads and retries. */
  async writePossession(digest: string, caller: Caller, row: PossessionRow, guard: WriteGuard): Promise<void> {
    const key = principalDigestKey(digest, caller);
    for (let attempt = 0; attempt < 4; attempt++) {
      const e = await this.kv.possess.get(key);
      try {
        guard("the possession row");
        if (e === null || e.operation !== "PUT") await this.kv.possess.create(key, json(row));
        else await this.kv.possess.update(key, json(row), e.revision);
        return;
      } catch (err) {
        if (!isCasLoss(err)) throw err;
      }
    }
    throw new Error("the possession row kept changing underneath its write; the commit did not finish, retry the put");
  }

  /** Consume the confirmer's own reservation (plan section 6). Deleting a reservation never extends a
   *  lifetime. */
  async deleteReservation(digest: string, caller: Caller, guard: WriteGuard): Promise<void> {
    guard("consuming the reservation");
    await this.kv.reserve.delete(principalDigestKey(digest, caller));
  }

  /** Insert-if-absent attach, index row first (S19). Returns `false` when a live channel row already
   *  exists, which is left exactly as it is: attach is idempotent and lifetime-neutral. An `expired`
   *  tombstone is not live, so a confirm over one is a new attachment with a new expiry. */
  async attachIfAbsent(channel: string, digest: string, row: AttachmentRow, guard: WriteGuard): Promise<boolean> {
    if ((await this.readAttachment(channel, digest))?.value.state === "attached") return false;
    guard("the attachment index row");
    await this.kv.attach.put(attachmentIndexKey(digest, channel), json({ channel }));
    const key = attachmentKey(channel, digest);
    const e = await this.kv.attach.get(key);
    try {
      if (e !== null && e.operation === "PUT" && e.json<AttachmentRow>().state === "attached") return false;
      guard("the attachment");
      if (e === null || e.operation !== "PUT") await this.kv.attach.create(key, json(row));
      else await this.kv.attach.update(key, json(row), e.revision);
    } catch (err) {
      if (!isCasLoss(err)) throw err;
      return false;
    }
    return true;
  }

  /** Roll back an attach this caller just made (confirm's possession re-read failed): channel row
   *  first, then the index row (S19). */
  async rollbackAttach(channel: string, digest: string, guard: WriteGuard): Promise<void> {
    guard("rolling back the attachment");
    await this.kv.attach.delete(attachmentKey(channel, digest));
    guard("rolling back the attachment index row");
    await this.kv.attach.delete(attachmentIndexKey(digest, channel));
  }

  /** Clear an attachment's expiry: the explicit lifetime act (plan section 7). CAS on the row it read. */
  async pin(channel: string, digest: string, guard: WriteGuard): Promise<boolean> {
    const cur = await this.readAttachment(channel, digest);
    if (cur === undefined || cur.value.state !== "attached") return false;
    if (cur.value.pinned) return true;
    guard("the pin");
    await this.kv.attach.update(attachmentKey(channel, digest), json({ ...cur.value, pinned: true }), cur.revision);
    return true;
  }
}
