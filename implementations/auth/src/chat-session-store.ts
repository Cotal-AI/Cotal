/**
 * The chat-session AUTHORITY RECORDS in the ep-auth KV (`KV_cotal_auth_<space>`, `allow_direct=false`,
 * so every `kv.get` here is the leader-served `STREAM.MSG.GET last_by_subj` read): the holder index, owner quota and sweep cursor.
 *
 *  - holder index `IDX` = `chatholder.<owner>.<holderHash>`: create-only, then revision-pinned CAS for
 *    every state change, NEVER deleted (one holderHash admits at most once for the life of the
 *    space);
 *  - owner quota `Q` = `chatowner.<owner>`: create-only when absent, then revision-pinned CAS; at
 *    most one `live` entry per holderHash; a fixed 60 s rate window that is never refunded;
 *  - sweep cursor = `chatsweep.cursor`: discovery position only, revision-pinned CAS.
 *
 * Writers: chat admission and the sweep, both inside the trusted auth process. No leaf, agent,
 * endpoint or operator credential holds any grant on these keys.
 *
 * Every value is a CLOSED schema: unknown fields, a DEL/PURGE marker or a key/value mismatch refuse
 * loudly (garbled trusted-path state never authorizes, SPEC 13.1). Every write uses core's
 * `createRecordEntry`/`updateRecordEntry` (the §13.8 create-only/pinned-CAS discipline), so a CAS
 * loss is a typed `conflict`, and every other broker failure is an UNKNOWN outcome that the caller
 * resolves by re-reading, never by assuming.
 */
import { randomBytes } from "node:crypto";
import type { KV, KvEntry } from "@nats-io/kv";
import type { JetStreamManager, MsgRequest } from "@nats-io/jetstream";
import {
  EpEnvelopeError,
  assertDerivedOwnerToken,
  assertLifecycleToken,
  createRecordEntry,
  epAuthBucket,
  updateRecordEntry,
} from "@cotal-ai/core";
import { assertChatActor, assertChatList, assertHolderHash, CHAT_SESSION_MAX_TTL_MS } from "./chat-session-row.js";

export const CHAT_HOLDER_PREFIX = "chatholder";
export const CHAT_OWNER_PREFIX = "chatowner";
export const CHAT_SWEEP_CURSOR_KEY = "chatsweep.cursor";

/** At most 16 non-retired sessions per owner. */
export const CHAT_LIVE_MAX = 16;
/** At most 10 admissions per fixed 60 s window, never refunded. */
export const CHAT_WINDOW_MS = 60_000;
export const CHAT_WINDOW_MAX = 10;
/** Bounded reservation attempts, each from a fresh leader read. */
export const CHAT_QUOTA_ATTEMPTS = 3;

const HEX64 = /^[0-9a-f]{64}$/;
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const epochMs = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const uint = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const closedKeys = (o: Record<string, unknown>, required: string[], optional: string[] = []): boolean =>
  required.every((k) => k in o) && Object.keys(o).every((k) => required.includes(k) || optional.includes(k));

/** Draw a fresh server-side chat actor `chat_<26 base32>` (130 bits). The caller never chooses it. */
export function drawChatActor(): string {
  const bytes = randomBytes(17);
  let bits = 0, acc = 0, out = "";
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5 && out.length < 26) {
      out += B32[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  return assertChatActor(`chat_${out}`);
}

// ---- keys ----------------------------------------------------------------------------------

export function chatHolderKey(owner: string, holderHash: string): string {
  return `${CHAT_HOLDER_PREFIX}.${assertDerivedOwnerToken(owner)}.${assertHolderHash(holderHash)}`;
}

export function chatOwnerKey(owner: string): string {
  return `${CHAT_OWNER_PREFIX}.${assertDerivedOwnerToken(owner)}`;
}

/** The closed set of KV publish subjects the chat writer needs (for the trusted writer's grant
 *  builder). Exact-arity wildcards only: never `.>` on a family that could later gain children. */
export function chatAuthorityWriteSubjects(space: string): string[] {
  const b = epAuthBucket(space);
  return [`$KV.${b}.${CHAT_HOLDER_PREFIX}.*.*`, `$KV.${b}.${CHAT_OWNER_PREFIX}.*`, `$KV.${b}.${CHAT_SWEEP_CURSOR_KEY}`];
}

// ---- IDX -----------------------------------------------------------------------------------

export type ChatHolderState = "reserved" | "provisioning" | "active" | "retired";
export type ChatRetiredBy = "sweep" | "close" | "rollback";
const HOLDER_STATES: ReadonlySet<string> = new Set(["reserved", "provisioning", "active", "retired"]);
const RETIRED_BY: ReadonlySet<string> = new Set(["sweep", "close", "rollback"]);

export interface ChatCeiling {
  read: string[];
  post: string[];
}

/** The closed `IDX` value. `parentPinDigest` is null ONLY on the sweep's S1 fence of an
 *  absent index, which is born `retired` with a null UID. */
export interface ChatHolderIndex {
  v: 1;
  state: ChatHolderState;
  actor: string;
  lifecycleUid: string | null;
  reservedAt: number;
  expiresAt: number;
  ceiling: ChatCeiling;
  parentPinDigest: string | null;
  retiredBy?: ChatRetiredBy;
}

export interface Versioned<T> {
  value: T;
  revision: number;
}

export function parseChatHolderIndex(raw: unknown, key: string): ChatHolderIndex {
  const bad = (why: string): never => {
    throw new EpEnvelopeError("internal", `the chat holder index ${key} ${why}; garbled trusted-path state never authorizes`);
  };
  if (!isRec(raw)) bad("is not an object");
  const o = raw as Record<string, unknown>;
  if (!closedKeys(o, ["v", "state", "actor", "lifecycleUid", "reservedAt", "expiresAt", "ceiling", "parentPinDigest"], ["retiredBy"]))
    bad(`carries fields ${JSON.stringify(Object.keys(o).sort())} outside the closed set`);
  if (o.v !== 1) bad("has an unknown version");
  if (typeof o.state !== "string" || !HOLDER_STATES.has(o.state)) bad("has an unknown state");
  try { assertChatActor(o.actor); } catch { bad("names a malformed actor"); }
  if (o.lifecycleUid !== null) {
    if (typeof o.lifecycleUid !== "string") bad("has a malformed lifecycleUid");
    try { assertLifecycleToken(o.lifecycleUid as string); } catch { bad("has a malformed lifecycleUid"); }
  }
  if (!epochMs(o.reservedAt) || !epochMs(o.expiresAt) || (o.expiresAt as number) < (o.reservedAt as number) ||
    (o.expiresAt as number) - (o.reservedAt as number) > CHAT_SESSION_MAX_TTL_MS) bad("has malformed reservedAt/expiresAt");
  if (!isRec(o.ceiling) || !closedKeys(o.ceiling as Record<string, unknown>, ["read", "post"])) bad("has a malformed ceiling");
  try {
    assertChatList((o.ceiling as Record<string, unknown>).read, "ceiling.read");
    assertChatList((o.ceiling as Record<string, unknown>).post, "ceiling.post");
  } catch { bad("has a malformed ceiling list"); }
  if (o.state === "retired") {
    if (typeof o.retiredBy !== "string" || !RETIRED_BY.has(o.retiredBy)) bad("is retired without retiredBy");
  } else if (o.retiredBy !== undefined) bad(`is ${String(o.state)} but carries retiredBy`);
  if (o.state === "provisioning" || o.state === "active") {
    if (o.lifecycleUid === null) bad(`is ${String(o.state)} without a lifecycleUid`);
  }
  if (o.parentPinDigest === null) {
    if (!(o.state === "retired" && o.retiredBy === "sweep" && o.lifecycleUid === null)) bad("has a null parentPinDigest outside the sweep fence");
  } else if (typeof o.parentPinDigest !== "string" || !HEX64.test(o.parentPinDigest)) bad("has a malformed parentPinDigest");
  return o as unknown as ChatHolderIndex;
}

/** The holder-index transition table, plus the immutables every CAS preserves. */
function assertHolderTransition(from: ChatHolderIndex, to: ChatHolderIndex, key: string): void {
  const refuse = (why: string): never => {
    throw new EpEnvelopeError("failed-precondition", `chat holder index ${key}: ${from.state} -> ${to.state} refused (${why})`);
  };
  if (from.actor !== to.actor || from.reservedAt !== to.reservedAt || from.expiresAt !== to.expiresAt ||
    from.parentPinDigest !== to.parentPinDigest || JSON.stringify(from.ceiling) !== JSON.stringify(to.ceiling))
    refuse("an immutable field changed");
  if (from.state === "retired") refuse("retired is terminal");
  if (to.state === "retired") {
    if (to.lifecycleUid !== from.lifecycleUid) refuse("retirement keeps the bound UID");
    return;
  }
  if (from.state === "reserved" && to.state === "reserved") {
    if (from.lifecycleUid !== null || to.lifecycleUid === null) refuse("lifecycleUid is set once, from null");
    return;
  }
  if (to.lifecycleUid !== from.lifecycleUid) refuse("the UID never changes after it is bound");
  if (from.state === "reserved" && to.state === "provisioning") return;
  if (from.state === "provisioning" && to.state === "active") return;
  refuse("not an allowed transition");
}

// ---- Q -------------------------------------------------------------------------------------

export interface ChatQuotaEntry {
  holderHash: string;
  actor: string;
  reservedAt: number;
}

export interface ChatOwnerQuota {
  v: 1;
  live: ChatQuotaEntry[];
  window: { startMs: number; count: number };
}

export function parseChatOwnerQuota(raw: unknown, key: string): ChatOwnerQuota {
  const bad = (why: string): never => {
    throw new EpEnvelopeError("internal", `the chat owner quota ${key} ${why}; garbled trusted-path state never authorizes`);
  };
  if (!isRec(raw) || !closedKeys(raw, ["v", "live", "window"]) || raw.v !== 1) bad("is not the closed v1 record");
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.live) || o.live.length > CHAT_LIVE_MAX) bad(`live must hold at most ${CHAT_LIVE_MAX} entries`);
  const seen = new Set<string>();
  for (const e of o.live as unknown[]) {
    if (!isRec(e) || !closedKeys(e, ["holderHash", "actor", "reservedAt"]) || typeof e.holderHash !== "string" || !HEX64.test(e.holderHash) || !epochMs(e.reservedAt))
      bad("carries a malformed live entry");
    try { assertChatActor((e as Record<string, unknown>).actor); } catch { bad("carries a live entry with a malformed actor"); }
    const h = (e as Record<string, unknown>).holderHash as string;
    if (seen.has(h)) bad("carries two live entries for one holderHash");
    seen.add(h);
  }
  if (!isRec(o.window) || !closedKeys(o.window, ["startMs", "count"]) || !uint(o.window.startMs) || !uint(o.window.count) || (o.window.count as number) > CHAT_WINDOW_MAX)
    bad("has a malformed window");
  return o as unknown as ChatOwnerQuota;
}

// ---- cursor --------------------------------------------------------------------------------

export interface ChatSweepCursor {
  v: 1;
  /** The last fully classified chat-session row file name ("" = start). */
  rowName: string;
  /** The auth-stream sequence of the last fully classified holder index (0 = start). */
  holderSeq: number;
}

export function parseChatSweepCursor(raw: unknown): ChatSweepCursor {
  if (!isRec(raw) || !closedKeys(raw, ["v", "rowName", "holderSeq"]) || raw.v !== 1 || typeof raw.rowName !== "string" || raw.rowName.length > 256 || !uint(raw.holderSeq))
    throw new EpEnvelopeError("internal", `the chat sweep cursor ${CHAT_SWEEP_CURSOR_KEY} is not the closed v1 record`);
  return raw as unknown as ChatSweepCursor;
}

// ---- the store ------------------------------------------------------------------------------

/** An outcome the caller must resolve by re-reading: the write may or may not have landed. */
export function unknownOutcome(what: string, cause: unknown): EpEnvelopeError {
  const err = new EpEnvelopeError("unavailable", `${what}: the write's outcome is unknown (${(cause as Error)?.message ?? String(cause)}); retry with the same holder to resolve it`, undefined, "unknown");
  (err as Error & { cause?: unknown }).cause = cause;
  return err;
}

const isConflict = (e: unknown): boolean => e instanceof EpEnvelopeError && e.code === "conflict";

function decode<T>(entry: KvEntry | null, key: string, parse: (raw: unknown, key: string) => T): Versioned<T> | undefined {
  if (entry === null) return undefined;
  if (entry.operation !== "PUT")
    throw new EpEnvelopeError("failed-precondition", `${key} carries a ${entry.operation} marker; a chat authority record is never deleted, so this is corruption (SPEC 13.12)`);
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder().decode(entry.value)); } catch { throw new EpEnvelopeError("internal", `${key} is not JSON`); }
  return { value: parse(raw, key), revision: entry.revision };
}

export interface QuotaReservation {
  actor: string;
  reservedAt: number;
  /** True when an existing entry for this holderHash was found and reused. */
  reused: boolean;
}

/** One scanned record from a bounded leader-served discovery page. */
export interface ScannedChatRecord {
  key: string;
  seq: number;
}

/**
 * The sealed chat authority store. Constructed only over the trusted auth path's own auth-store KV
 * (`registryStores(reg).authKv`) and its JetStream manager; it adds no connection or grant.
 */
export interface ChatAuthorityStore {
  readHolder(owner: string, holderHash: string): Promise<Versioned<ChatHolderIndex> | undefined>;
  /** a2: create-only `reserved`. `lost` = another writer's index exists (the retry path). */
  createHolderReserved(owner: string, holderHash: string, value: ChatHolderIndex): Promise<{ created: true; revision: number } | { created: false }>;
  /** S1 for an absent index: create-only `retired`, null UID. `lost` = an admission created it first. */
  createHolderFence(owner: string, holderHash: string, entry: ChatQuotaEntry): Promise<{ created: true; revision: number } | { created: false }>;
  /** Pinned CAS on an existing index; checks the transition table first. `conflict` on a
   *  moved revision; an unknown broker outcome throws `unknownOutcome`. */
  casHolder(owner: string, holderHash: string, from: Versioned<ChatHolderIndex>, to: ChatHolderIndex): Promise<Versioned<ChatHolderIndex>>;
  readQuota(owner: string): Promise<Versioned<ChatOwnerQuota> | undefined>;
  /** a1: reserve or reuse this holder's live entry. Refuses `conflict` (16 live) or
   *  `resource-exhausted` (window); exhausted attempts are UNKNOWN, never a refusal. */
  reserveQuota(owner: string, holderHash: string, now: number): Promise<QuotaReservation>;
  /** S3: remove this holder's entry, pinned on the revision whose entry the caller classified. */
  releaseQuotaEntry(owner: string, holderHash: string, observed: Versioned<ChatOwnerQuota>): Promise<"released" | "absent">;
  /** Reconcile: rewrite this holder's entry actor to the index actor; the slot stays counted. */
  rewriteQuotaEntryActor(owner: string, holderHash: string, actor: string, observed: Versioned<ChatOwnerQuota>): Promise<"rewritten" | "absent">;
  readCursor(): Promise<Versioned<ChatSweepCursor> | undefined>;
  /** Pinned CAS (create-only when `observed` is undefined). `conflict` = a peer advanced it. */
  casCursor(observed: Versioned<ChatSweepCursor> | undefined, next: ChatSweepCursor): Promise<number>;
  /** A bounded leader-served discovery page (`STREAM.MSG.GET next_by_subj`, no consumer: none may
   *  be created on the auth stream). Returns at most `limit` live keys after `afterSeq`. */
  scanPage(family: "holder" | "owner", afterSeq: number, limit: number): Promise<ScannedChatRecord[]>;
}

export function openChatAuthorityStore(kv: KV, jsm: JetStreamManager, space: string): ChatAuthorityStore {
  const readHolder = async (owner: string, h: string) => {
    const key = chatHolderKey(owner, h);
    return decode(await kv.get(key), key, parseChatHolderIndex);
  };
  const readQuota = async (owner: string) => {
    const key = chatOwnerKey(owner);
    return decode(await kv.get(key), key, parseChatOwnerQuota);
  };
  const createOnly = async (key: string, value: unknown): Promise<{ created: true; revision: number } | { created: false }> => {
    try {
      return { created: true, revision: await createRecordEntry(kv, key, value) };
    } catch (e) {
      if (isConflict(e)) return { created: false };
      throw unknownOutcome(`create of ${key}`, e);
    }
  };
  const writeQuota = async (owner: string, observed: Versioned<ChatOwnerQuota> | undefined, next: ChatOwnerQuota): Promise<number> => {
    const key = chatOwnerKey(owner);
    parseChatOwnerQuota(next, key);
    try {
      return observed === undefined ? await createRecordEntry(kv, key, next) : await updateRecordEntry(kv, key, next, observed.revision);
    } catch (e) {
      if (isConflict(e)) throw e;
      throw unknownOutcome(`write of ${key}`, e);
    }
  };

  return {
    readHolder,
    readQuota,

    async createHolderReserved(owner, h, value) {
      const key = chatHolderKey(owner, h);
      if (value.state !== "reserved" || value.lifecycleUid !== null || value.retiredBy !== undefined)
        throw new EpEnvelopeError("internal", `${key}: an admission index is born reserved with a null UID`);
      parseChatHolderIndex(value, key);
      return createOnly(key, value);
    },

    async createHolderFence(owner, h, entry) {
      const key = chatHolderKey(owner, h);
      if (entry.holderHash !== h) throw new EpEnvelopeError("internal", `${key}: the fence names another holder`);
      const fence: ChatHolderIndex = {
        v: 1, state: "retired", actor: entry.actor, lifecycleUid: null, reservedAt: entry.reservedAt, expiresAt: entry.reservedAt,
        ceiling: { read: [], post: [] }, parentPinDigest: null, retiredBy: "sweep",
      };
      parseChatHolderIndex(fence, key);
      return createOnly(key, fence);
    },

    async casHolder(owner, h, from, to) {
      const key = chatHolderKey(owner, h);
      parseChatHolderIndex(to, key);
      assertHolderTransition(from.value, to, key);
      try {
        return { value: to, revision: await updateRecordEntry(kv, key, to, from.revision) };
      } catch (e) {
        if (isConflict(e)) throw e;
        throw unknownOutcome(`CAS of ${key}`, e);
      }
    },

    async reserveQuota(owner, h, now) {
      assertHolderHash(h);
      if (!epochMs(now)) throw new EpEnvelopeError("internal", "reserveQuota needs the authority clock");
      let lastUnknown: unknown;
      for (let attempt = 0; attempt < CHAT_QUOTA_ATTEMPTS; attempt++) {
        const observed = await readQuota(owner);
        const q: ChatOwnerQuota = observed?.value ?? { v: 1, live: [], window: { startMs: 0, count: 0 } };
        const mine = q.live.find((e) => e.holderHash === h);
        // The reservation landed (this attempt's predecessor, an unknown ack, or a concurrent same-
        // holder admission): reuse it, never add a second entry, never count it twice.
        if (mine) return { actor: mine.actor, reservedAt: mine.reservedAt, reused: true };
        if (q.live.length >= CHAT_LIVE_MAX) {
          const oldest = [...q.live].sort((a, b) => a.reservedAt - b.reservedAt)[0];
          throw new EpEnvelopeError("conflict", `owner ${owner} already holds ${CHAT_LIVE_MAX} chat sessions; the oldest is ${oldest.actor} (reserved ${new Date(oldest.reservedAt).toISOString()}). Close one, or wait for it to expire, then open again`);
        }
        const current = now - q.window.startMs < CHAT_WINDOW_MS && q.window.startMs <= now;
        if (current && q.window.count >= CHAT_WINDOW_MAX)
          throw new EpEnvelopeError("resource-exhausted", `owner ${owner} opened ${CHAT_WINDOW_MAX} chat sessions in this minute; retry after ${new Date(q.window.startMs + CHAT_WINDOW_MS).toISOString()}`);
        const entry: ChatQuotaEntry = { holderHash: h, actor: drawChatActor(), reservedAt: now };
        const next: ChatOwnerQuota = {
          v: 1,
          live: [...q.live, entry],
          window: current ? { startMs: q.window.startMs, count: q.window.count + 1 } : { startMs: now, count: 1 },
        };
        try {
          await writeQuota(owner, observed, next);
          return { actor: entry.actor, reservedAt: entry.reservedAt, reused: false };
        } catch (e) {
          if (isConflict(e)) continue; // a peer moved Q: re-read and re-decide
          lastUnknown = e; // unknown ack: the next leader read decides whether it landed
        }
      }
      // Exhausted. Never a refusal that could hide a landed reservation.
      throw unknownOutcome(`chat quota reservation for owner ${owner}`, lastUnknown ?? new Error("the quota record kept moving"));
    },

    async releaseQuotaEntry(owner, h, observed) {
      const live = observed.value.live.filter((e) => e.holderHash !== h);
      if (live.length === observed.value.live.length) return "absent";
      await writeQuota(owner, observed, { ...observed.value, live });
      return "released";
    },

    async rewriteQuotaEntryActor(owner, h, actor, observed) {
      assertChatActor(actor);
      const at = observed.value.live.findIndex((e) => e.holderHash === h);
      if (at < 0) return "absent";
      const live = observed.value.live.map((e, i) => (i === at ? { ...e, actor } : e));
      await writeQuota(owner, observed, { ...observed.value, live });
      return "rewritten";
    },

    async readCursor() {
      return decode(await kv.get(CHAT_SWEEP_CURSOR_KEY), CHAT_SWEEP_CURSOR_KEY, (raw) => parseChatSweepCursor(raw));
    },

    async casCursor(observed, next) {
      parseChatSweepCursor(next);
      try {
        return observed === undefined
          ? await createRecordEntry(kv, CHAT_SWEEP_CURSOR_KEY, next)
          : await updateRecordEntry(kv, CHAT_SWEEP_CURSOR_KEY, next, observed.revision);
      } catch (e) {
        if (isConflict(e)) throw e;
        throw unknownOutcome(`CAS of ${CHAT_SWEEP_CURSOR_KEY}`, e);
      }
    },

    async scanPage(family, afterSeq, limit) {
      if (!uint(afterSeq) || !Number.isSafeInteger(limit) || limit < 1) throw new EpEnvelopeError("bad-request", "scanPage needs a sequence and a positive limit");
      const bucket = epAuthBucket(space);
      const prefix = `$KV.${bucket}.`;
      const filter = family === "holder" ? `${prefix}${CHAT_HOLDER_PREFIX}.*.*` : `${prefix}${CHAT_OWNER_PREFIX}.*`;
      const out: ScannedChatRecord[] = [];
      let seq = afterSeq + 1;
      while (out.length < limit) {
        let m;
        try {
          m = await jsm.streams.getMessage(`KV_${bucket}`, { seq, next_by_subj: filter } as unknown as MsgRequest);
        } catch (e) {
          if ((e as { code?: unknown }).code === 10037) break; // no further message on the filter
          throw e;
        }
        if (!m) break;
        seq = m.seq + 1;
        const op = m.header?.get("KV-Operation");
        if (op) throw new EpEnvelopeError("failed-precondition", `${m.subject} carries a ${op} marker; chat authority records are never deleted (SPEC 13.12)`);
        out.push({ key: m.subject.slice(prefix.length), seq: m.seq });
      }
      return out;
    },
  };
}

/** Parse a scanned holder key back to its coordinates; anything else refuses. */
export function parseChatHolderKey(key: string): { owner: string; holderHash: string } {
  const parts = key.split(".");
  if (parts.length !== 3 || parts[0] !== CHAT_HOLDER_PREFIX) throw new EpEnvelopeError("internal", `${key} is not a chat holder key`);
  return { owner: assertDerivedOwnerToken(parts[1]), holderHash: assertHolderHash(parts[2]) };
}

/** Parse a scanned owner-quota key back to its owner; anything else refuses. */
export function parseChatOwnerKey(key: string): string {
  const parts = key.split(".");
  if (parts.length !== 2 || parts[0] !== CHAT_OWNER_PREFIX) throw new EpEnvelopeError("internal", `${key} is not a chat owner key`);
  return assertDerivedOwnerToken(parts[1]);
}
