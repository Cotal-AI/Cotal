/**
 * Anycast request status (SPEC §8.1): the delivery daemon's record of the role requests a holder took
 * or their sender cancelled, and the take, status and cancel decisions made against it.
 *
 * A role request can sit in a holder's connector buffer before its agent sees it, and the broker has
 * no way to tell that holder later that the request was deleted. So a connector that follows this
 * contract asks the daemon to record its take before it shows a request, and a sender cancels
 * through the same record. One row per request, keyed by the TASK stream's creation time and the
 * request's sequence, decides between the two: every first write is create-if-absent, and every
 * later write is CAS-fenced on the row's KV revision.
 *
 * A take moves the row only to a later delivery of the same request (a higher broker delivery
 * count) while the request is still queued. The daemon cannot verify a delivery count, so a holder
 * of the role can claim a later delivery and move a take to itself; SPEC §8.1 states that limit.
 */
import type { JetStreamManager } from "@nats-io/jetstream";
import type { KV, KvEntry } from "@nats-io/kv";
import { isCasLoss } from "./endpoint-records.js";
import { parseSubject } from "./subjects.js";

/** How long a row outlives its request once the request has left the queue. A row is never removed
 *  while its request is still queued, so a long-held request keeps its record. */
export const ANYCAST_RECORD_RETENTION_MS = 24 * 60 * 60 * 1000;

/** The control ops a sender calls on `ctl.delivery` for one of its own requests, and the probe a
 *  holder uses to tell an older daemon from a stopped one. */
export const ANYCAST_STATUS_OP = "anycastStatus";
export const ANYCAST_CANCEL_OP = "anycastCancel";
export const ANYCAST_TAKES_OP = "anycastTakes";

/** What a daemon whose credential cannot open the records bucket answers on every anycast op. A
 *  credential minted before the records existed lacks their grants. */
export const ANYCAST_RECORDS_CREDENTIAL_OUTDATED =
  "this delivery daemon's credential was minted before anycast request records existed, so it records no takes and answers no status or cancel; restart the daemon on a credential minted at this version (`cotal up` mints one)";

/** The key of the data part that marks a delivery daemon's notice to a sender. */
export const ANYCAST_NOTICE_KEY = "cotalAnycastNotice";

export type AnycastHolderRef = {
  id: string;
  name: string;
};

/** The structured half of a notice the daemon sends a request's sender. */
export type AnycastNotice = {
  seq: number;
  role: string;
  event: "taken" | "redelivered";
  taker: AnycastHolderRef;
  /** The holder that took it before and did not confirm it (`redelivered` only). */
  previous?: AnycastHolderRef;
};

/** What a holder sends to take one request it was delivered. `count` is the broker's delivery count
 *  for the copy it holds, 1 on the first delivery. */
export interface AnycastTakeRequest {
  from: AnycastHolderRef;
  seq: number;
  id: string;
  count: number;
}

/** Why a take was refused. The first four tell the holder to drop its copy unseen; `busy` tells it
 *  to keep the copy and ask again later. */
export type AnycastTakeRefusal = "cancelled" | "taken" | "gone" | "mismatch" | "busy";

export type AnycastTakeReply = { ok: true } | { ok: false; code: AnycastTakeRefusal; error: string };

/** One request's state as its sender may learn it. `unknown` covers a request that is not on the
 *  queue and has no record, and a seq that is not the caller's: the daemon never guesses a winner and
 *  never describes another sender's request. */
export type AnycastStatus =
  | { state: "waiting"; seq: number; role: string }
  | { state: "taken"; seq: number; role: string; taker: AnycastHolderRef; previous?: AnycastHolderRef; at: number }
  | { state: "cancelled"; seq: number; role: string; removal: AnycastRemoval }
  | { state: "unknown"; seq: number };

/** How a cancelled request left the queue. `already-gone` means it was off the queue when the
 *  daemon tried to remove it, which only a holder that skips the take step can cause. */
export type AnycastRemoval = "pending" | "deleted" | "already-gone";

interface OutboxEvent {
  key: string;
  text: string;
  notice: AnycastNotice;
}

/** One row of the records bucket. */
export interface AnycastRecord {
  v: 1;
  /** The TASK stream's creation time when the row was written: a recreated stream reuses
   *  sequences, and its requests never match an older row. */
  epoch: string;
  seq: number;
  id: string;
  role: string;
  /** The request's sender principal, from its stored subject. */
  sender: string;
  /** Transition counter; part of each notice's key. */
  rev: number;
  state: "taken" | "cancelled";
  taker?: AnycastHolderRef & { count: number; at: number };
  previous?: AnycastHolderRef & { count: number };
  removal?: AnycastRemoval;
  /** When the daemon first found the request off the queue. */
  leftAt?: number;
  /** Notices owed to the sender, oldest first. */
  outbox: OutboxEvent[];
}

/** A request as the queue stores it: its role and sender from the stored subject, and its id. */
export interface StoredRequest {
  role: string;
  sender: string;
  id: string;
}

/** The KV key of one request's row. */
export function anycastRecordKey(epoch: string, seq: number): string {
  return `r.${epoch.replace(/[^0-9A-Za-z]/g, "")}.${seq}`;
}

/** A seq a caller may name: a whole number the queue could have assigned. */
export function isAnycastSeq(seq: unknown): seq is number {
  return typeof seq === "number" && Number.isSafeInteger(seq) && seq > 0;
}

function holderOf(t: AnycastHolderRef): AnycastHolderRef {
  return { id: t.id, name: t.name };
}

function noticeEvent(row: AnycastRecord, notice: AnycastNotice): OutboxEvent {
  const { taker, previous, role, seq } = notice;
  const text = notice.event === "taken"
    ? `${taker.name} (${taker.id}) took your @${role} request (seq ${seq}).`
    : `${previous!.name} (${previous!.id}) did not confirm your @${role} request (seq ${seq}) before its ack wait ran out, ` +
      `and ${taker.name} (${taker.id}) took it. ${previous!.name} may already have started it.`;
  return { key: `anycast.${anycastRecordKey(row.epoch, row.seq).slice(2)}.${row.rev}`, text, notice };
}

/** Decide one take against the row, given the request as the queue stores it now. Returns the reply
 *  and, when the take changes the row, the row to write. Pure. */
export function decideTake(
  row: AnycastRecord | undefined,
  stored: StoredRequest,
  t: { epoch: string; seq: number; holder: AnycastHolderRef; count: number; now: number },
): { reply: AnycastTakeReply; next?: AnycastRecord } {
  const taker = { ...holderOf(t.holder), count: t.count, at: t.now };
  if (!row) {
    const next: AnycastRecord = {
      v: 1, epoch: t.epoch, seq: t.seq, id: stored.id, role: stored.role, sender: stored.sender, rev: 1,
      state: "taken", taker, outbox: [],
    };
    next.outbox.push(noticeEvent(next, { seq: t.seq, role: stored.role, event: "taken", taker: holderOf(taker) }));
    return { reply: { ok: true }, next };
  }
  if (row.state === "cancelled")
    return { reply: { ok: false, code: "cancelled", error: `request seq ${t.seq} was cancelled by its sender` } };
  const current = row.taker!;
  if (current.id === t.holder.id && current.count === t.count) return { reply: { ok: true } };
  if (t.count > current.count) {
    const moved = current.id !== t.holder.id;
    const next: AnycastRecord = {
      ...row,
      rev: row.rev + 1,
      taker,
      previous: moved ? { ...holderOf(current), count: current.count } : row.previous,
      outbox: [...row.outbox],
    };
    if (moved) next.outbox.push(noticeEvent(next, { seq: t.seq, role: row.role, event: "redelivered", taker: holderOf(taker), previous: holderOf(current) }));
    return { reply: { ok: true }, next };
  }
  return {
    reply: { ok: false, code: "taken", error: `request seq ${t.seq} was taken by ${current.name} (${current.id}) on delivery ${current.count}` },
  };
}

/** The status a row or the queue gives the caller. Pure. */
export function statusFor(
  row: AnycastRecord | undefined,
  stored: StoredRequest | undefined,
  q: { seq: number; caller: string; id?: string },
): AnycastStatus {
  if (row) {
    if (row.sender !== q.caller || (q.id !== undefined && row.id !== q.id)) return { state: "unknown", seq: q.seq };
    if (row.state === "cancelled") return { state: "cancelled", seq: q.seq, role: row.role, removal: row.removal ?? "pending" };
    const taker = row.taker!;
    return {
      state: "taken", seq: q.seq, role: row.role, taker: holderOf(taker), at: taker.at,
      ...(row.previous ? { previous: holderOf(row.previous) } : {}),
    };
  }
  if (!stored || stored.sender !== q.caller || (q.id !== undefined && stored.id !== q.id)) return { state: "unknown", seq: q.seq };
  return { state: "waiting", seq: q.seq, role: stored.role };
}

/** Decide one cancel. Returns the status to answer with and, when the cancel wins, the row to create.
 *  Only a request still waiting is cancelled; a taken one is refused with its taker. Pure. */
export function decideCancel(
  row: AnycastRecord | undefined,
  stored: StoredRequest | undefined,
  q: { epoch: string; seq: number; caller: string; id?: string; now: number },
): { status: AnycastStatus; next?: AnycastRecord } {
  const status = statusFor(row, stored, q);
  if (status.state !== "waiting") return { status };
  const s = stored!;
  return {
    status: { state: "cancelled", seq: q.seq, role: s.role, removal: "pending" },
    next: { v: 1, epoch: q.epoch, seq: q.seq, id: s.id, role: s.role, sender: s.sender, rev: 1, state: "cancelled", removal: "pending", outbox: [] },
  };
}

/** Read a request off the TASK stream, or `undefined` when nothing usable is stored at that seq. */
function storedRequest(subject: string, data: Uint8Array): StoredRequest | undefined {
  const parsed = parseSubject(subject);
  if (!parsed || parsed.kind !== "svc") return undefined;
  let id: unknown;
  try { id = (JSON.parse(new TextDecoder().decode(data)) as { id?: unknown }).id; } catch { return undefined; }
  if (typeof id !== "string") return undefined;
  return { role: parsed.rest, sender: parsed.sender, id };
}

function isNoMessageFound(e: unknown): boolean {
  return (e as { code?: unknown } | null)?.code === 10037 || /no message found/i.test(String((e as Error | null)?.message ?? ""));
}

const encoder = new TextEncoder();

function readRow(e: KvEntry | null): AnycastRecord | undefined {
  if (!e || e.operation !== "PUT") return undefined;
  const row = e.json<AnycastRecord>();
  if (row?.v !== 1 || typeof row.epoch !== "string" || !isAnycastSeq(row.seq) || !Array.isArray(row.outbox))
    throw new Error(`anycast record ${e.key} is not a version-1 record`);
  return row;
}

/** The daemon's side of anycast request status: reads the queue, writes the records bucket, and
 *  sends the notices each transition owes. The caller supplies `send` (a DM from the daemon's own
 *  principal, published with the event key as its message id) and `mayAct`, the daemon's
 *  still-serving fence, which is asked again after every await that precedes an effect. */
export class AnycastRequestAuthority {
  private readonly flushing = new Map<string, Promise<void>>();

  constructor(private readonly deps: {
    jsm: JetStreamManager;
    kv: KV;
    stream: string;
    send: (to: string, event: { key: string; text: string; notice: AnycastNotice }) => Promise<void>;
    mayAct: () => boolean;
    onError: (e: Error) => void;
    now?: () => number;
  }) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** The stream's creation time and the request stored at `seq`, read so that both come from one
   *  stream: a recreation between the reads is retried. */
  private async queued(seq: number): Promise<{ epoch: string; stored?: StoredRequest }> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = (await this.deps.jsm.streams.info(this.deps.stream)).created;
      const sm = await this.deps.jsm.streams.getMessage(this.deps.stream, { seq });
      const after = (await this.deps.jsm.streams.info(this.deps.stream)).created;
      if (before !== after) continue;
      return { epoch: before, stored: sm ? storedRequest(sm.subject, sm.data) : undefined };
    }
    throw new Error(`the ${this.deps.stream} stream was recreated during the read; retry`);
  }

  /** Record a take. `role` comes from the take subject, `holder.id` from its authenticated sender. */
  async take(role: string, req: AnycastTakeRequest): Promise<AnycastTakeReply> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const { epoch, stored } = await this.queued(req.seq);
      if (!stored) {
        // A cancel deletes the request, so the record says why it is gone when it is.
        const row = readRow(await this.deps.kv.get(anycastRecordKey(epoch, req.seq)));
        if (row?.state === "cancelled" && row.id === req.id)
          return { ok: false, code: "cancelled", error: `request seq ${req.seq} was cancelled by its sender` };
        return { ok: false, code: "gone", error: `request seq ${req.seq} is no longer on the queue` };
      }
      if (stored.role !== role || stored.id !== req.id)
        return { ok: false, code: "mismatch", error: `seq ${req.seq} on the queue is not the @${role} request ${req.id}` };
      const key = anycastRecordKey(epoch, req.seq);
      const entry = await this.deps.kv.get(key);
      const { reply, next } = decideTake(readRow(entry), stored, { epoch, seq: req.seq, holder: req.from, count: req.count, now: this.now() });
      if (!next) return reply;
      if (!this.deps.mayAct()) return { ok: false, code: "busy", error: "the delivery daemon stopped serving while the take was in flight; retry" };
      if (!(await this.write(key, next, entry))) continue;
      if (next.outbox.length) this.flushSoon(key);
      return reply;
    }
    return { ok: false, code: "busy", error: `request seq ${req.seq} changed under five takes in a row; retry` };
  }

  async status(caller: string, q: { seq: number; id?: string }): Promise<AnycastStatus> {
    const { epoch, stored } = await this.queued(q.seq);
    const row = readRow(await this.deps.kv.get(anycastRecordKey(epoch, q.seq)));
    return statusFor(row, stored, { ...q, caller });
  }

  async cancel(caller: string, q: { seq: number; id?: string }): Promise<AnycastStatus> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const { epoch, stored } = await this.queued(q.seq);
      const key = anycastRecordKey(epoch, q.seq);
      const entry = await this.deps.kv.get(key);
      const row = readRow(entry);
      const { status, next } = decideCancel(row, stored, { ...q, epoch, caller, now: this.now() });
      if (!next) {
        // A retry after a lost reply finishes a removal the first attempt left pending.
        if (status.state === "cancelled" && status.removal === "pending") return this.remove(key);
        return status;
      }
      if (!this.deps.mayAct()) throw new Error("the delivery daemon stopped serving while the cancel was in flight; retry");
      if (!(await this.write(key, next, entry))) continue;
      return this.remove(key);
    }
    throw new Error(`request seq ${q.seq} changed under five cancels in a row; retry`);
  }

  /** Delete a cancelled request from the queue, once, and only from the stream its row was written
   *  against, then record how it left. */
  private async remove(key: string): Promise<AnycastStatus> {
    let removal: AnycastRemoval | undefined;
    for (let attempt = 0; attempt < 5; attempt++) {
      const entry = await this.deps.kv.get(key);
      const row = readRow(entry);
      if (!row || row.state !== "cancelled") throw new Error(`anycast record ${key} is not a cancelled request`);
      if (row.removal !== "pending") return { state: "cancelled", seq: row.seq, role: row.role, removal: row.removal ?? "pending" };
      if (removal === undefined) {
        const epoch = (await this.deps.jsm.streams.info(this.deps.stream)).created;
        if (epoch !== row.epoch) removal = "already-gone";
        else {
          if (!this.deps.mayAct()) return { state: "cancelled", seq: row.seq, role: row.role, removal: "pending" };
          try {
            await this.deps.jsm.streams.deleteMessage(this.deps.stream, row.seq, false);
            removal = "deleted";
          } catch (e) {
            if (!isNoMessageFound(e)) throw e;
            removal = "already-gone";
          }
        }
      }
      if (await this.write(key, { ...row, removal }, entry)) return { state: "cancelled", seq: row.seq, role: row.role, removal };
    }
    throw new Error(`anycast record ${key} changed under five writes in a row; retry`);
  }

  /** Create the row when `entry` held none, or update it at `entry`'s revision. False on a CAS loss. */
  private async write(key: string, row: AnycastRecord, entry: KvEntry | null): Promise<boolean> {
    try {
      const bytes = encoder.encode(JSON.stringify(row));
      if (entry && entry.operation === "PUT") await this.deps.kv.update(key, bytes, entry.revision);
      else await this.deps.kv.create(key, bytes);
      return true;
    } catch (e) {
      if (isCasLoss(e) || /wrong last sequence|key exists/i.test(String((e as Error).message))) return false;
      throw e;
    }
  }

  private flushSoon(key: string): void {
    void this.flush(key).catch((e) => this.deps.onError(e as Error));
  }

  /** Send a row's owed notices in order, removing each only after it was published. One flush per
   *  row at a time; a resend after a crash carries the same message id, which the DM stream's
   *  duplicate window and the receiver both use to drop the copy. */
  private flush(key: string): Promise<void> {
    const prior = this.flushing.get(key) ?? Promise.resolve();
    const run = prior.then(async () => {
      for (let attempt = 0; attempt < 16; attempt++) {
        if (!this.deps.mayAct()) return;
        const entry = await this.deps.kv.get(key);
        const row = readRow(entry);
        const event = row?.outbox[0];
        if (!row || !event) return;
        await this.deps.send(row.sender, event);
        await this.write(key, { ...row, outbox: row.outbox.filter((e) => e.key !== event.key) }, entry);
      }
    });
    const settled = run.finally(() => { if (this.flushing.get(key) === settled) this.flushing.delete(key); });
    this.flushing.set(key, settled);
    return settled;
  }

  /** One maintenance pass over every row: resend owed notices, finish pending removals, note when a
   *  request has left the queue, and drop rows that left more than {@link ANYCAST_RECORD_RETENTION_MS}
   *  ago. It reads the queue only at the seqs the rows name. */
  async sweep(): Promise<void> {
    const keys: string[] = [];
    for await (const k of await this.deps.kv.keys("r.>")) keys.push(k);
    for (const key of keys) {
      if (!this.deps.mayAct()) return;
      try { await this.maintain(key); } catch (e) { this.deps.onError(e as Error); }
    }
  }

  private async maintain(key: string): Promise<void> {
    let row = readRow(await this.deps.kv.get(key));
    if (!row) return;
    if (row.outbox.length) await this.flush(key);
    if (row.state === "cancelled" && row.removal === "pending") await this.remove(key);
    const entry = await this.deps.kv.get(key);
    row = readRow(entry);
    if (!row || !this.deps.mayAct()) return;
    if (row.leftAt === undefined) {
      const { epoch, stored } = await this.queued(row.seq);
      if (epoch === row.epoch && stored?.id === row.id) return;
      await this.write(key, { ...row, leftAt: this.now() }, entry);
    } else if (this.now() - row.leftAt > ANYCAST_RECORD_RETENTION_MS && !row.outbox.length) {
      try { await this.deps.kv.delete(key, { previousSeq: entry!.revision }); } catch (e) { if (!isCasLoss(e)) throw e; }
    }
  }
}
