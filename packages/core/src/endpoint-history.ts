import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { nanos, type NatsConnection } from "@nats-io/transport-node";
import { jetstream, jetstreamManager, AckPolicy, DeliverPolicy, JetStreamApiError, type JetStreamClient, type JetStreamManager, type Consumer, type ConsumerInfo, type ConsumerConfig, type JsMsg } from "@nats-io/jetstream";
import { chatStream, dmStream, chatSubject, chatHistDurable, spacePrefix, parseSubject, subjectMatches, assertValidChannel, assertValidOwnerToken, isConcreteChannel, isChannelFamily, historyReaderConsumer, HISTORY_READERS, calloutReaderId, patternCovers, type ParsedSubject } from "./subjects.js";
import { channelInGrant, exclusionsOverlapping } from "./channel-grant.js";
import { isConsumerAlreadyExists, isConsumerNotFound } from "./jetstream-missing.js";
import { isPermissionDenied } from "./permission-denied.js";
import type { CotalMessage, HistoryMessage, Delivery, MessageMeta, ControlReply } from "./types.js";
import type { HistoryPage } from "./endpoint.js";

/** Current transport and shared lifecycle operations used by history reads. */
export interface EndpointHistoryDeps {
  connection: () => NatsConnection | undefined;
  jetstream: () => JetStreamClient | undefined;
  manager: () => JetStreamManager | undefined;
  setManager: (manager: JetStreamManager | undefined) => void;
  space: () => string;
  owner: () => string;
  actor: () => string;
  userMode: () => boolean;
  connectionId: () => string;
  card: () => { id: string };
  notLiveMsg: () => string;
  requireLifecycleUid: (operation: string) => string;
  requestDelivery: (op: string, args: Record<string, unknown>) => Promise<ControlReply>;
  deleteConsumerIfPresent: (stream: string, name: string) => Promise<void>;
  joinPolicyFresh: (channel: string) => Promise<{ replay: boolean; windowMs?: number }>;
  chatMayHaveLost: (channel: string, sinceSeq: number) => Promise<boolean>;
  allowSubscribe: () => string[] | undefined;
  excludeSubscribe: () => readonly string[];
  emit: (event: string, ...args: unknown[]) => boolean;
  decodeHistory: (message: { subject: string; json: <T>() => T }) => HistoryMessage | undefined;
  isRecord: (value: unknown) => value is Record<string, unknown>;
  isUsableMessageId: (value: unknown) => value is string;
  isFromSubjectSender: (message: unknown, parsed: ParsedSubject) => boolean;
  authenticatedMessage: <M extends CotalMessage>(message: M, parsed: ParsedSubject) => CotalMessage & M;
  isPublishPermissionDenied: (error: unknown) => boolean;
}


/** A history reader's inactive threshold. It bounds only a reader whose delete never ran (its link
 *  dropped, or its process stopped), because every read deletes its readers when it ends. Five
 *  minutes is what the nats.js ordered consumers it replaces carried, and it keeps a reader alive
 *  across the gap between pulls on a slow link. */
const HISTORY_READER_INACTIVE_MS = 5 * 60_000;


/** One read's hold on a history-reader name (see {@link CotalEndpoint}'s `acquireHistoryReader`). */
type HistoryReader = {
  nc: NatsConnection;
  js: JetStreamClient;
  jsm: JetStreamManager;
  stream: string;
  pool: HistoryReaderSlots;
  slot: number;
  name: string;
  /** False once the hold is given back, so it is given back once. */
  held: boolean;
  /** True once a delete under the name failed, so the name may still hold this read's reader and is
   *  set aside rather than freed when the hold is given back. */
  left: boolean;
};


/** One stream's history-reader names under one reader id: the free slots, how many reads hold one,
 *  the reads waiting, and until when a read fails at once because the credential was refused a
 *  reader delete. A slot neither free nor held is set aside until a consumer under it would have
 *  expired. */
type HistoryReaderSlots = {
  readerId: string;
  free: number[];
  held: number;
  waiting: (() => void)[];
  refusedUntil: number;
};


/** How many channel filters one multi-filter consumer create may carry.
 *
 *  A create names every requested channel in one request, so the request grows with the channel
 *  count and the CLIENT's request timeout is what gives way, not the broker: the create is never
 *  refused, it just does not answer. Measured on an isolated broker, one message per channel,
 *  `limit=5`: 70 filters answer in 43ms, 1,000 in 246ms, 5,000 in 5,345ms, and 10,000 does not
 *  answer at all, failing `timeout` after 5,023ms. Note 5,000 SUCCEEDED while taking longer than
 *  10,000 took to fail, which is what says the ceiling is on the create request rather than on the
 *  read: past roughly 5s the create itself is what times out.
 *
 *  1,000 is chosen from that sweep rather than from the failure point: it is a fifth of the largest
 *  count that still answered, and it answers in a quarter second, so a batch stays far away from
 *  both the timeout and the response-deadline budget the dashboard has to share with its DM read.
 *  A space with the 69 chat channels this was built for is still ONE read, so the round-trip claim
 *  in #1210 is unchanged at that size. */
export const MULTI_FILTER_BATCH = 1_000;


/** How many filter batches may be in flight at once. Bounded because the point of #1210 was to stop
 *  issuing one read per channel: a space large enough to need batches must not get the fan-out back
 *  under another name. */
export const MULTI_FILTER_READ_CONCURRENCY = 4;


/** What a history read failure NAMES when it could not finish. One filter subject is the useful
 *  thing to print; a set of sixty-nine of them is a wall of text in a message a human has to read,
 *  so a set says its size and the stream it was read from instead. */
function subjectLabel(subjects: string[]): string {
  return subjects.length === 1 ? subjects[0] : `${subjects.length} filtered subjects`;
}


/** The signal's exact abort reason, or the platform-standard AbortError when none was supplied. */
function abortReason(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException("This operation was aborted", "AbortError");
}

/** `p`, or the caller's abort reason as soon as `signal` fires. A delivery request cannot be
 *  withdrawn once sent, so an abort stops the caller waiting and paging; the late reply is dropped
 *  when its reply subscription ends. */
function abortable<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
      (e: unknown) => { signal.removeEventListener("abort", onAbort); reject(e); },
    );
  });
}

/** The delivery daemon answered a mediated read and refused it, or answered with a page this
 *  endpoint cannot accept. It is the mediated twin of a broker permission denial on a direct read:
 *  history is unreadable, which is not the same answer as history being empty. */
class MediatedReadRefused extends Error {}

/** Retained-history reads and private reader allocation for one endpoint. */
export class EndpointHistory {

  /** Serializes history reads ({@link collectHistory}): they share the fixed per-instance
   *  `chathist_<id>` consumer, so overlapping reads would delete/recreate it under one another. */
  private histLock: Promise<unknown> = Promise.resolve();

  /** Per stream, the history-reader names of this connection's current reader id and the reads
   *  waiting for one (see {@link acquireHistoryReader}). */
  private readonly historyReaderSlots = new Map<string, HistoryReaderSlots>();
  constructor(private readonly deps: EndpointHistoryDeps) {}
  private get nc() { return this.deps.connection(); }
  private get js() { return this.deps.jetstream(); }
  private get jsm() { return this.deps.manager(); }
  private set jsm(manager: JetStreamManager | undefined) {
    this.deps.setManager(manager);
  }
  private get space() { return this.deps.space(); }
  private get owner() { return this.deps.owner(); }
  private get actor() { return this.deps.actor(); }
  private get userMode() { return this.deps.userMode(); }
  private get connId() { return this.deps.connectionId(); }
  private get card() { return this.deps.card(); }


  /** Fetch recent messages from a channel's JetStream backlog. `signal` cancels the active pull and
   *  reclaims its ephemeral consumer before the promise rejects. Returns `HistoryMessage[]`
   *  (#1413): every field present on a row was checked by the drain before the row was
   *  returned — a stored row missing `ts` / `space` / `parts` / `from.name` is dropped, never
   *  returned with that member silently `undefined`.
   *
   *  `publisher` reads only what that one principal published on the channel, by filtering on its
   *  own subject (`chat.<owner>.<actor>.<channel>`). The subject's sender slots are what the
   *  broker's publish permissions police, so on a mesh with permissions every row of such a read was
   *  published by that principal: the same guarantee a live subscription to that subject gives.
   *  Without it the read is the channel from any sender. */
  async channelHistory(
    channel: string,
    opts?: { limit?: number; signal?: AbortSignal; publisher?: { owner: string; actor: string } },
  ): Promise<HistoryMessage[]> {
    const from = opts?.publisher;
    // A publisher is one principal. A `*` in either slot would widen the read back to any sender
    // while the caller believes it narrowed it, so both slots are checked as concrete tokens.
    const subject = from === undefined
      ? chatSubject(this.space, "*", "*", channel)
      : chatSubject(this.space, assertValidOwnerToken(from.owner), assertValidOwnerToken(from.actor), channel);
    return (await this.streamHistory(
      chatStream(this.space),
      [subject],
      opts?.limit ?? 100,
      undefined,
      opts?.signal,
    )).map((r) => r.msg);
  }


  /** Read one concrete channel using this lifecycle's single-filter CHAT grant (SPEC §8/§9).
   *  No observer authority, presence or delivery ACL mirror is required. Returns the newest page,
   *  oldest-first, including this caller's own sends. `complete` says no older valid row remains.
   *  Reads have a ten-second budget, shortened by `signal`. Concurrent connections sharing this
   *  lifecycle wait for native consumer inactivity cleanup; they never delete another reader. */
  async channelHistoryPage(
    channel: string,
    opts?: { limit?: number; signal?: AbortSignal },
  ): Promise<HistoryPage> {
    assertValidChannel(channel);
    if (!isConcreteChannel(channel)) throw new Error("channelHistoryPage requires one concrete channel");
    const limit = opts?.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new Error("channelHistoryPage limit must be a positive safe integer");
    const signal = AbortSignal.any([AbortSignal.timeout(10_000), ...(opts?.signal ? [opts.signal] : [])]);
    signal.throwIfAborted();
    if (this.mediated(channel)) return this.readHistory(channel, { limit, signal });
    if (!this.nc || !this.js) throw new Error(this.deps.notLiveMsg());
    const jsm = this.jsm ??= await jetstreamManager(this.nc);
    const stream = chatStream(this.space);
    const name = chatHistDurable(this.owner, this.actor, this.deps.requireLifecycleUid("channelHistoryPage"));
    const subject = chatSubject(this.space, "*", "*", channel);
    const marker = randomUUID();
    let created: ConsumerInfo;
    for (;;) {
      signal.throwIfAborted();
      try {
        // The pinned client's add is CREATE-only. A unique description makes even an otherwise
        // identical occupied config conflict. Never bind/update it or pre-delete by shared name.
        created = await jsm.consumers.add(stream, {
          name, description: marker, filter_subject: subject,
          ack_policy: AckPolicy.None, deliver_policy: DeliverPolicy.All,
          mem_storage: true, inactive_threshold: nanos(250),
        });
        break;
      } catch (e) {
        if (!(e instanceof JetStreamApiError) || e.code !== 10148) throw e; // consumer already exists
        await delay(50, undefined, { signal });
      }
    }
    signal.throwIfAborted();
    const owns = (info: ConsumerInfo) => info.created === created.created &&
      info.config.description === marker && info.config.filter_subject === subject;
    if (!owns(created)) throw new Error("channelHistoryPage: consumer ownership was not established");
    const consumer = await this.js.consumers.get(stream, name);
    const pending = created.num_pending;
    const out: CotalMessage[] = [];
    let delivered = 0;
    if (pending > 0) {
      const iter = await consumer.consume({ max_messages: Math.min(pending, 32) });
      const stop = () => iter.stop(abortReason(signal));
      signal.addEventListener("abort", stop, { once: true });
      try {
        signal.throwIfAborted();
        for await (const m of iter) {
          signal.throwIfAborted();
          if (!subjectMatches(subject, m.subject))
            throw new Error("channelHistoryPage: consumer delivered another channel; ownership was lost");
          delivered++;
          const msg = this.deps.decodeHistory(m);
          if (msg) {
            out.push(msg);
            if (out.length > limit + 1) out.shift();
          }
          if (delivered >= pending) break;
        }
      } finally {
        signal.removeEventListener("abort", stop);
        iter.stop();
      }
      signal.throwIfAborted();
      if (delivered !== pending)
        throw new Error(`channelHistoryPage: read ${delivered} of ${pending} messages before the window was cut short`);
    }
    signal.throwIfAborted();
    // A legacy join/recall reader can delete/recreate this fixed name. A final ownership check
    // makes that interference loud. It is detection, not a fence against those legacy readers.
    if (!owns(await consumer.info())) throw new Error("channelHistoryPage: consumer ownership was lost");
    signal.throwIfAborted();
    // No DELETE, even after abort: a delayed owner could otherwise delete its successor between
    // INFO and DELETE. Native inactivity reaps this transient reader without that TOCTOU race.
    return { items: out.slice(-limit), complete: out.length <= limit };
  }


  /**
   * The newest `limit` chat messages across concrete channels or one channel family, oldest-first within the page,
   * each tagged with the channel the BROKER delivered it on.
   *
   * The CHAT stream interleaves every channel into one sequence space. Consumers take sets of
   * filter subjects for the requested channels. Large filter sets are read in batches, and the
   * pages are merged by stream sequence to select the newest `limit` messages overall.
   *
   * **The broker does the filtering, so the wire carries only what is asked for.** A channel left
   * out of `channels` costs nothing: its messages are never delivered, so a space whose volume is
   * dominated by channels the caller does not want stays cheap.
   *
   * **The channel comes from the SUBJECT, never from the payload.** A message claims a `channel`
   * field, and this method ignores it: the tag is derived from the subject the broker routed the
   * message on, the same derivation {@link listChannels} uses to name a channel in the first place.
   *
   * A single channel family such as `events.>` uses one broker filter without enumerating its
   * concrete channels. Otherwise every channel must be concrete: mixing a family with other
   * filters, or using other wildcard patterns, is refused rather than risking overlapping filters.
   *
   * **The broker enforces read authority.** A multi-filter create
   * cannot encode its filter in the API subject, so it rides the bare
   * `$JS.API.CONSUMER.CREATE.<CHAT>` row that only the read-only dashboard profiles hold. An agent
   * credential pins the filter into the subject per channel and is denied here by the broker, which
   * is the correct answer: this method reads across channels, and an agent's read ACL is per
   * channel. A single filter uses the filter-bearing create subject, including a channel family,
   * so the broker checks the credential's grant for that filter. No additional authority is minted.
   */
  async multiChannelHistory(
    channels: readonly string[],
    opts?: { limit?: number; signal?: AbortSignal; batch?: number },
  ): Promise<{ channel: string; seq: number; msg: HistoryMessage }[]> {
    const subjects = [...new Set(channels.map((channel) => {
      if (!isConcreteChannel(channel) && !(channels.length === 1 && isChannelFamily(channel)))
        throw new Error(`multiChannelHistory: "${channel}" is a wildcard channel - name one channel family alone or concrete channels without wildcards`);
      // `chatSubject` builds the filter through `token()`, which REWRITES rather than refuses: it
      // maps a character a subject may not carry to `_`, trims each segment, and drops empty ones.
      // So "foo/bar" would filter on `foo_bar`, ".lead" on `lead`, and "team..b" on `team.b` - the
      // caller names one channel and the broker returns another, which is the exact promise this
      // method makes ("a channel left out of the list never crosses the link") inverted. This is the
      // same aliasing `assertValidChannel` was written for on the policy path; the read path needs
      // it too, and it fails loud rather than serving a channel nobody asked for.
      assertValidChannel(channel);
      return chatSubject(this.space, "*", "*", channel);
    }))];
    // No channels is not an empty stream, but it IS an empty answer, and asking the broker for a
    // consumer with no filter would read the WHOLE stream instead of none of it.
    if (subjects.length === 0) return [];
    const limit = opts?.limit ?? 100;
    // ONE CREATE CANNOT CARRY AN UNBOUNDED FILTER LIST. The create names every subject in one
    // request and the client's request timeout is what gives way, so past roughly 5,000 filters the
    // read does not answer at all and the route loses the whole chat source: measured on an
    // isolated broker, 10,000 channels failed `timeout` after 5,023ms while the fan-out this
    // replaced still returned 2,739 messages on the same corpus. Reading in batches keeps the
    // single-read cost at the sizes this was built for (69 channels is one batch, so #1210's
    // round-trip numbers are unchanged) and degrades to a few reads instead of none above that.
    // `batch` is a knob rather than a constant so the batched path can be compared against the
    // single-create path on ONE corpus: forcing a small batch makes a space that would otherwise be
    // one read take many, which is the only way to assert the two select the same messages.
    const size = Math.max(1, Math.trunc(opts?.batch ?? MULTI_FILTER_BATCH));
    const batches: string[][] = [];
    for (let i = 0; i < subjects.length; i += size)
      batches.push(subjects.slice(i, i + size));
    const pages: { seq: number; subject: string; msg: HistoryMessage }[][] = new Array(batches.length);
    let next = 0;
    const readBatch = async (): Promise<void> => {
      for (;;) {
        const i = next++;
        if (i >= batches.length) return;
        pages[i] = await this.streamHistory(
          chatStream(this.space), batches[i], limit, undefined, opts?.signal,
        );
      }
    };
    // A BATCH THAT FAILS FAILS THE READ. Returning the batches that answered would be the newest
    // `limit` across SOME of the channels asked for while looking like the newest across all of
    // them, which is a wrong page presented as a right one. Throwing keeps the caller's existing
    // envelope: the dashboard marks `chat` missing and says the page is partial, which is what it
    // already did when this method was one read.
    await Promise.all(
      Array.from({ length: Math.min(MULTI_FILTER_READ_CONCURRENCY, batches.length) }, readBatch),
    );
    // MERGE ON ARRIVAL, NOT ON `ts`. Each batch returns the newest `limit` within its own subjects,
    // and the newest `limit` overall is a subset of their union, so re-selecting by stream sequence
    // reproduces exactly what one create over the whole list would have selected. Sorting by the
    // payload's `ts` here instead would change which messages the page holds, which is the
    // selection question this pull request already had to answer once.
    const rows = pages.flat().sort((a, b) => a.seq - b.seq).slice(-limit);
    return rows.map(({ seq, subject, msg }) => {
      const p = parseSubject(subject);
      // The filter set is built from chat subjects, so this cannot fire against a healthy broker.
      // It is here because the alternative to raising is tagging a message with a guess.
      if (p?.kind !== "chat")
        throw new Error(`multiChannelHistory: the broker delivered ${subject}, which is not a chat subject on this space`);
      return { channel: p.rest, seq, msg };
    });
  }


  /** Read a channel's recent history through the delivery daemon, using a provisioned ACL mirror.
   *  SPEC's ban on raw control-surface stream reads does not remove the single-channel CHAT grant.
   *  Human callers without an ACL mirror use {@link channelHistoryPage}; this method adds fresh
   *  mirror checks for provisioned readers. `items` is shape-identical to what {@link channelHistory}
   *  returns — the same `CotalMessage[]`, the same newest-N selection, the same oldest-first order
   *  within the page — so a caller migrates by reading `.items` and nothing else changes. The return
   *  is WRAPPED rather than bare precisely because of `complete`: a bare array cannot say whether
   *  older history remains behind it.
   *
   *  **Why this exists when `channelHistory` already works:** authorization. A consumer pins its
   *  authorization at CREATE time, so a caller whose read ACL is revoked mid-scroll keeps being served
   *  by the consumer it already holds. The mediator re-reads authorization on EVERY call (live
   *  registry row ∩ mint-time ceiling — SPEC §9.6), so a revocation stops the very next read and a
   *  registry-only widen cannot exceed the effective credential. That is the whole point of the verb;
   *  a mediator that cached the ACL would be a rename of the path it replaces.
   *
   *  **The caller never names itself.** The daemon takes the principal from the broker-authenticated
   *  request subject ({@link serveControl} fail-closes when the payload `from` disagrees), so there is
   *  no caller-supplied identity to forge.
   *
   *  A channel outside the caller's read ACL THROWS. It must never come back as an empty page: "you
   *  may not read this" and "there is nothing here" are different answers and only one is safe to
   *  render as an empty conversation.
   *
   *  Chat channels only — DM history is deliberately not served here (it is god-view-only today, a
   *  different authorization model, and one handler with two authz paths is the wrong shape on the
   *  surface where a mistake exposes messages). */
  async readHistory(channel: string, opts?: { limit?: number; signal?: AbortSignal }): Promise<HistoryPage> {
    opts?.signal?.throwIfAborted();
    const reply = await abortable(this.deps.requestDelivery("readHistory", { channel, limit: opts?.limit }), opts?.signal);
    if (!reply.ok) throw new Error(reply.error ?? "readHistory failed");
    const data = reply.data as { items?: unknown; complete?: unknown } | undefined;
    // Validate rather than coerce. A malformed reply must not be massaged into a plausible page:
    // defaulting `complete` would invent the very signal a caller uses to decide whether it is
    // looking at the start of a conversation.
    if (!Array.isArray(data?.items) || typeof data?.complete !== "boolean")
      throw new Error("readHistory: the delivery daemon returned a malformed page (expected { items, complete })");
    return { items: data.items as CotalMessage[], complete: data.complete };
  }


  /** Is history under `filter` read through the delivery daemon? It is when no allow entry that
   *  covers `filter` is free of read exclusions: the mint withholds the history create row of every
   *  entry an exclusion overlaps (SPEC §9), so the broker would refuse the direct read. */
  mediated(filter: string): boolean {
    const exclude = this.deps.excludeSubscribe();
    if (exclude.length === 0) return false;
    return !(this.deps.allowSubscribe() ?? []).some((a) => patternCovers(a, filter) && exclusionsOverlapping(a, exclude).length === 0);
  }


  /** Read `filter`'s history from `fromSeq` through the delivery daemon's mediated range read
   *  (`readRange`, SPEC §8), ascending, draining its pages until `untilSeq` (or the newest row when
   *  absent) or `limit` rows. `sinceMs` bounds the start by age when `fromSeq` is 1. The daemon
   *  authenticates each row's sender and channel from its subject and drops what this caller may
   *  not read; a row outside `filter` or this endpoint's own grant is refused here as a daemon fault.
   *  A refusal or a malformed page throws: it is never read as an empty history. `signal` stops the
   *  drain: no further page is asked for, and the call rejects with the signal's reason. */
  async readRange(
    filter: string,
    opts: { fromSeq: number; untilSeq?: number; sinceMs?: number; limit?: number; signal?: AbortSignal },
  ): Promise<{ seq: number; message: CotalMessage }[]> {
    const out: { seq: number; message: CotalMessage }[] = [];
    const allow = this.deps.allowSubscribe() ?? [], exclude = this.deps.excludeSubscribe();
    let fromSeq = opts.fromSeq, untilSeq = opts.untilSeq;
    for (;;) {
      opts.signal?.throwIfAborted();
      const reply = await abortable(this.deps.requestDelivery("readRange", {
        filter, fromSeq,
        ...(untilSeq !== undefined ? { untilSeq } : {}),
        ...(fromSeq === 1 && opts.sinceMs !== undefined ? { sinceMs: opts.sinceMs } : {}),
        ...(opts.limit !== undefined ? { limit: opts.limit - out.length } : {}),
      }), opts.signal);
      if (!reply.ok) throw new MediatedReadRefused(reply.error ?? "readRange failed");
      const data = reply.data as { items?: unknown; untilSeq?: unknown; next?: unknown; done?: unknown } | undefined;
      const seq = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
      if (!Array.isArray(data?.items) || !seq(data.untilSeq) || !seq(data.next) || typeof data.done !== "boolean"
        || (!data.done && data.next <= fromSeq))
        throw new MediatedReadRefused("readRange: the delivery daemon returned a malformed page (expected { items, untilSeq, next, done } that advances)");
      for (const item of data.items as unknown[]) {
        const row = item as { seq?: unknown; message?: unknown };
        const channel = this.deps.isRecord(row?.message) ? row.message.channel : undefined;
        if (!seq(row?.seq) || row.seq < fromSeq || row.seq > data.untilSeq || typeof channel !== "string"
          || !subjectMatches(filter, channel) || !channelInGrant(allow, exclude, channel))
          throw new MediatedReadRefused(`readRange: the delivery daemon served a row outside "${filter}" or this grant - refused`);
        out.push({ seq: row.seq, message: row.message as CotalMessage });
      }
      if (data.done || (opts.limit !== undefined && out.length >= opts.limit)) return out;
      fromSeq = data.next;
      untilSeq = data.untilSeq;
    }
  }


  /** The sequence of the oldest retained message on concrete `channel` this endpoint may read, or
   *  `undefined` when it holds none. */
  async oldestChannelSeq(channel: string): Promise<number | undefined> {
    if (this.mediated(channel)) return (await this.readRange(channel, { fromSeq: 1, limit: 1 }))[0]?.seq;
    return (await this.collectHistory(chatSubject(this.space, "*", "*", channel), { seq: 1 }, { limit: 1 }))[0]?.seq;
  }


  /** Fetch recent DMs (any sender→any recipient) from the space's DM backlog. `signal` cancels the
   *  active pull and reclaims its ephemeral consumer. God-view only:
   *  a normal agent/observer's ACL denies CONSUMER.CREATE on DM_<space>, so this throws-and-
   *  skips for them — only an `admin`-profile cred can read it. Returns `HistoryMessage[]`
   *  (#1413): every field present on a row was checked by the drain before the row was
   *  returned — a stored row missing `ts` / `space` / `parts` / `from.name` is dropped, never
   *  returned with that member silently `undefined`. */
  async dmHistory(opts?: { limit?: number; signal?: AbortSignal }): Promise<HistoryMessage[]> {
    try {
      // every inst.<recipOwner>.<recipActor>.<sndOwner>.<sndActor> DM — the whole DM subtree (god-view)
      return (await this.streamHistory(
        dmStream(this.space),
        [`${spacePrefix(this.space)}.inst.>`],
        opts?.limit ?? 100,
        undefined,
        opts?.signal,
      )).map((r) => r.msg);
    } catch (e) {
      if (isPermissionDenied(e)) return [];
      throw e;
    }
  }


  /**
   * The `limit` MOST RECENT messages matching `subject`, oldest-first within the page.
   *
   * **This used to return the OLDEST N.** `js.consumers.get(stream, {...})` builds an ORDERED
   * consumer, which defaults to `DeliverPolicy.StartSequence` with `opt_start_seq: 1` — the very
   * beginning of the stream. Capping the fetch at `limit` therefore took the first N messages ever
   * sent, while this method is documented as "recent" and every caller (the dashboard feed, the
   * agent-facing history tools) presents the result as the latest. Confirmed live against a
   * 123-message channel: `limit=10` returned the ten oldest, not the ten newest.
   *
   * Fixing it by draining from the start and keeping the tail would be correct and ruinous: it
   * transfers the entire backlog to show one screen. Instead, find the newest matching sequence and
   * consume a WINDOW ending there, widening geometrically until the window holds `limit` matches.
   * A filtered subject's sequences are non-contiguous (other channels interleave in the same
   * stream), so the window cannot be computed arithmetically. A FAILED attempt holds fewer than a
   * page by definition, so wasted transfer stays page-sized and geometric growth keeps the number of
   * attempts logarithmic. A channel with fewer than `limit` matches used to keep widening until
   * sequence 1 and drain the stream's whole retained set (#840). The walk now stops at the
   * subject's FIRST matching sequence (the mirror of the last-matching ceiling), probed on the
   * same CREATE surface, and only after a short drain so a dense page never pays for the floor.
   *
   * `before` pages toward the past: pass the `seq` of the oldest message you already have.
   */
  async streamHistory(
    stream: string,
    subjects: string[],
    limit: number,
    before?: number,
    signal?: AbortSignal,
  ): Promise<{ seq: number; subject: string; msg: HistoryMessage }[]> {
    if (!this.nc) throw new Error(this.deps.notLiveMsg());
    signal?.throwIfAborted();
    // A LIMIT THAT IS NOT A FINITE NUMBER HAS NO ANSWER, AND THE SEARCH BELOW CANNOT REFUSE IT.
    // Every comparison against NaN is false, so `limit <= 0` does not fire for one, and neither of
    // the widening loop's exits can ever be true either: `page.length >= NaN` is false forever and
    // `start === 1` compares against a `start` that is itself NaN. The loop does not return
    // everything, it never returns. Measured through the dashboard on a real broker: no answer
    // after 30s, and the abandoned read still consuming half a core fifteen seconds after its
    // caller had gone, while the process kept serving every other route so nothing announced it.
    // `Infinity` reaches the other end of the same hole: it passes the guard, `start` collapses to
    // 1, and `slice(-Infinity)` is the subject's whole retained set.
    // A caller that computed a limit it cannot state is told so, rather than handed a process that
    // quietly spins. `0` and negatives keep their existing meaning, an empty page.
    // A COUNT OF MESSAGES IS A WHOLE NUMBER THIS SERVER CAN COUNT EXACTLY, and the check sits ABOVE
    // the zero check on purpose: `-Infinity <= 0` is true, so a guard placed below it would fold a
    // limit nobody can answer into a silent empty page. `NaN` never returns (both widening exits
    // compare against it and are false forever). `Infinity` and any magnitude past the safe range
    // collapse `start` to 1. A fraction is the quietest of the set: the page is taken with
    // `slice(-limit)` and slice truncates toward zero, so any limit in (0,1) becomes `slice(0)` and
    // hands back the ENTIRE retained history. Measured on 30 retained: 0.5 and 0.9 both returned all
    // 30, and 2.5 returned 2, a page nobody asked for.
    if (!Number.isSafeInteger(limit))
      throw new Error(`history limit must be a whole number of messages this server can count exactly, received ${limit}`);
    if (limit <= 0) return [];
    const nc = this.nc;
    let reader: HistoryReader | undefined;
    try {
      reader = await this.acquireHistoryReader(nc, this.jsm ?? (this.jsm = await jetstreamManager(nc)), stream, signal);
      // THE EXACT CEILING, on the already-granted surface. A one-shot consumer with
      // `DeliverPolicy.Last` plus this subject's filter reports the newest MATCHING sequence, and its
      // `num_pending` of zero means the channel is genuinely empty. Using the STREAM's last sequence
      // instead (which is all `STREAM.INFO` offers) was a loose upper bound, and on a quiet channel
      // in a busy stream the gap between the two is the whole problem: every window near the stream
      // head is empty, so the search widened over and over before finding anything.
      //
      // Deliberately NOT `getMessage({ last_by_subj })`, which would be the obvious way to ask: it
      // needs `$JS.API.STREAM.MSG.GET`, which read credentials do not hold. That grant hole already
      // shipped once from this function and turned every non-admin history read into an empty list.
      const ceiling = before !== undefined ? before - 1 : await this.lastMatchingSeq(reader, subjects, signal);
      if (ceiling < 1) return [];

      // Widen from the exact ceiling until a window holds a full page, or until the window IS the
      // whole subject. Draining each attempt is bounded, and that is the point: a window only fails
      // when it holds FEWER than `limit` matches, so every wasted drain moves less than one page.
      // Geometric growth keeps the number of attempts logarithmic, so total wasted transfer is a
      // small multiple of a page.
      //
      // THE FIRST WINDOW IS ONE PAGE WIDE, NOT FOUR. It used to open at `limit * 4` on the reasoning
      // that a filtered subject is sparse inside its stream and a wider first look would land the
      // page in one drain. That is true for one channel of a busy stream and false for a subject
      // that IS most of its stream, and the second case is the one a whole-backlog read takes: the
      // window succeeds on the first attempt and drains four pages to keep one, because
      // `drainWindow` delivers everything in the window and keeps the tail. Measured on `/api/dms`
      // at limit 500 against a 2500-message backlog: 1,995,854 to 1,995,859 bytes moved across
      // four runs to return a 346,001-byte page, and 8161ms to 8753ms on that link, so all four
      // missed the dashboard's 8000ms deadline with nothing else on the connection (Cotal #1210).
      // That cost does not keep growing with the backlog, and saying it did was wrong: the old first
      // span was `max(limit * 4, 64)`, so at limit 500 it is 2000 messages, and ANY backlog of 2000
      // or more drains the same 2000-message window. The point is that the window, not the backlog,
      // sets the cost, and four pages to return one is already past the deadline on this link for
      // every such deployment. One page wide makes the
      // SUCCESSFUL drain
      // obey the same bound the failed ones already promised: it moves at most one page. A sparse
      // subject pays one more widening step for that, which is four round trips against a transfer
      // several times the size of the answer.
      //
      // A SHORT PAGE is either "the channel is exhausted" or "the window is still above the
      // first match". Sequence 1 is the wrong floor for the first of those: three matches at
      // the high end of a busy stream are exhausted as soon as the window's lower edge passes
      // the subject's first matching sequence, and walking on to 1 re-reads everyone else's
      // retained set (#840). Probe that floor only after a short drain so a dense page (one
      // drain, full) never pays for it. The remaining unbounded-looking case is a subject
      // whose FIRST match really is near sequence 1; that span is the channel's own, not the
      // stream's.
      let span = Math.max(limit, 64);
      let floor = 1;
      let floorKnown = false;
      for (;;) {
        signal?.throwIfAborted();
        const start = Math.max(floor, ceiling - span + 1);
        const page = await this.drainWindow(reader, subjects, start, ceiling, limit, signal);
        if (page.length >= limit) return page.slice(-limit);
        if (!floorKnown) {
          floor = Math.max(1, await this.firstMatchingSeq(reader, subjects, signal));
          floorKnown = true;
        }
        if (start <= floor) return page.slice(-limit);
        span *= 4;
      }
    } catch (e) {
      // NARROW. This catch is how the MSG.GET grant bug shipped: it turned a Permissions Violation
      // into an empty history, so every non-admin read looked exactly like a quiet channel, and the
      // smokes stayed green because they run as admin against a local broker. Emitting on the error
      // event is not enough either — callers consume the RETURN VALUE, and the dashboard renders
      // empty regardless of what an operator log says.
      //
      // So only one thing may still produce an empty result here: the stream does not exist (a space
      // with no history yet). Anything else — a denial, a timeout, a 503, a protocol or
      // consumer-create failure — is raised, because "no history" and "I could not read the history"
      // are different answers and only one of them is safe to render as an empty conversation.
      // `dmHistory` alone turns a denial into its documented empty god-view result.
      const msg = String((e as { message?: unknown } | null)?.message ?? "");
      if (/stream not found/i.test(msg) || (e as { code?: number } | null)?.code === 404) return [];
      throw e;
    } finally {
      if (reader) this.releaseHistoryReader(reader);
    }
  }


  /** One ascending page of CHAT under `subject`, the served side of the mediated range read
   *  (`readRange`, SPEC §8). The delivery daemon reads with its own CHAT grant, and `keep` applies the
   *  caller's grant to each row BEFORE the page is cut, so rows the caller may not read never take a
   *  place in it.
   *
   *  The page starts at `fromSeq` (or `sinceMs` ago when `fromSeq` is 1) and ends at `untilSeq`. With
   *  no `untilSeq` the newest matching sequence is resolved and returned, so a caller paging on passes
   *  it back and a busy stream cannot extend the read. A page stops at `limit` kept rows, at `budget`
   *  encoded bytes, after `scanLimit` scanned rows, or once `timeMs` has passed, so neither a stretch
   *  of rows the caller may not read nor a slow stream holds the daemon. `next` is the first sequence
   *  not yet scanned and moves past every row looked at, kept or not; `done` says the scan reached
   *  `untilSeq` or no matching row is left. A kept row larger than `budget` throws, because it can
   *  never be sent, and so does a page that scanned nothing in its time. Rows are pulled in bounded
   *  fetches, so rows removed during the read (a channel purge) end the scan instead of leaving it
   *  waiting for them. */
  async readChatRange(
    subject: string,
    opts: {
      fromSeq: number; untilSeq?: number; sinceMs?: number;
      limit: number; budget: number; scanLimit: number; timeMs: number;
      keep: (msg: HistoryMessage) => boolean;
    },
  ): Promise<{ rows: { seq: number; message: HistoryMessage }[]; untilSeq: number; next: number; done: boolean }> {
    if (!this.nc) throw new Error(this.deps.notLiveMsg());
    const nc = this.nc;
    const deadline = Date.now() + opts.timeMs;
    const rows: { seq: number; message: HistoryMessage }[] = [];
    const reader = await this.acquireHistoryReader(nc, this.jsm ?? (this.jsm = await jetstreamManager(nc)), chatStream(this.space));
    try {
      const untilSeq = opts.untilSeq ?? await this.lastMatchingSeq(reader, [subject], AbortSignal.timeout(opts.timeMs));
      if (untilSeq < opts.fromSeq) return { rows, untilSeq, next: opts.fromSeq, done: true };
      const since = opts.fromSeq === 1 && opts.sinceMs !== undefined ? Date.now() - opts.sinceMs : undefined;
      const consumer = await this.openHistoryReader(reader, {
        filter_subjects: [subject],
        ...(since !== undefined && since > 0
          ? { deliver_policy: DeliverPolicy.StartTime, opt_start_time: new Date(since).toISOString() }
          : { deliver_policy: DeliverPolicy.StartSequence, opt_start_seq: opts.fromSeq }),
      });
      try {
        const pending = (await consumer.info(true)).num_pending;
        if (pending === 0) return { rows, untilSeq, next: untilSeq + 1, done: true };
        const enc = new TextEncoder();
        let delivered = 0, bytes = 0, next = opts.fromSeq, done = false, full = false;
        while (!done && !full && Date.now() < deadline) {
          const want = Math.min(256, opts.scanLimit - delivered);
          // `expires` has a 1 s floor in the client, so a page may overrun `timeMs` by up to that.
          const iter = await consumer.fetch({ max_messages: want, expires: Math.max(1_000, deadline - Date.now()) });
          let got = 0;
          for await (const m of iter) {
            got++;
            delivered++;
            if (m.info.deliverySequence !== delivered)
              throw new Error(`history: delivery ${m.info.deliverySequence} arrived where ${delivered} was due on ${subject} - the range has a gap, so the page is not served`);
            if (m.seq > untilSeq) { done = true; break; }
            const message = this.deps.decodeHistory(m);
            if (message && opts.keep(message)) {
              const size = enc.encode(JSON.stringify({ seq: m.seq, message })).length + 1; // + the `,` separator
              if (size > opts.budget)
                throw new Error(`history: the message at sequence ${m.seq} on ${subject} alone exceeds the reply budget (${opts.budget} bytes) - refused loudly rather than skipped`);
              if (rows.length >= opts.limit || bytes + size > opts.budget) { full = true; break; } // it opens the next page
              rows.push({ seq: m.seq, message });
              bytes += size;
            }
            next = m.seq + 1;
            if (m.seq === untilSeq || delivered >= pending) { done = true; break; }
            if (delivered >= opts.scanLimit) { full = true; break; }
          }
          // A short fetch with nothing left to deliver means the remaining rows were removed.
          if (!done && !full && got < want && (await consumer.info(true)).num_pending === 0) done = true;
        }
        if (!done && !full) {
          if (delivered === 0)
            throw new Error(`history: no message on ${subject} arrived within ${opts.timeMs}ms - the page is refused, not served as empty`);
          full = true;
        }
        return { rows, untilSeq, next: done ? untilSeq + 1 : next, done };
      } finally {
        await this.closeHistoryReader(reader);
      }
    } finally {
      this.releaseHistoryReader(reader);
    }
  }


  /** This connection's history-reader id, the key of its credential's reader deletes
   *  ({@link historyReaderConsumer}). A static credential's is its connId, the nkey it signs with.
   *  Under the auth callout the connId is the inbox nonce this client chose, so the callout keys the
   *  deletes on {@link calloutReaderId} instead: the server's id and the client id it assigned this
   *  connection, which the client reads from the server's INFO and does not choose. */
  historyReaderId(nc: NatsConnection): string {
    if (!this.userMode) return this.connId;
    const info = nc.info;
    if (!info) throw new Error("history: the server has not sent its INFO, so this connection has no history reader id yet");
    return calloutReaderId(info.server_id, info.client_id);
  }


  /** Take one of this connection's history-reader names on `stream` ({@link historyReaderConsumer})
   *  for one read. The read holds the name for its whole walk and creates and deletes a consumer
   *  under it at each step, so this connection keeps at most {@link HISTORY_READERS} reader consumers
   *  on a stream (#4123). A read past that many waits for a name, and `signal` ends the wait. A
   *  reconnect under the auth callout changes the reader id, and reads from then on take the new
   *  id's names. */
  async acquireHistoryReader(
    nc: NatsConnection,
    jsm: JetStreamManager,
    stream: string,
    signal?: AbortSignal,
  ): Promise<HistoryReader> {
    for (;;) {
      signal?.throwIfAborted();
      const readerId = this.historyReaderId(nc);
      let pool = this.historyReaderSlots.get(stream);
      if (pool?.readerId !== readerId) {
        pool = { readerId, free: Array.from({ length: HISTORY_READERS }, (_, i) => HISTORY_READERS - 1 - i), held: 0, waiting: [], refusedUntil: 0 };
        this.historyReaderSlots.set(stream, pool);
      }
      // A read here would leave one more reader it may not delete, so it fails before creating one.
      if (pool.refusedUntil > Date.now()) throw this.readerDeleteRefused(stream);
      const slot = pool.free.pop();
      if (slot !== undefined) {
        pool.held++;
        return { nc, js: jetstream(nc), jsm, stream, pool, slot, name: historyReaderConsumer(readerId, slot), held: true, left: false };
      }
      // No read here holds a name, so none will come back from one: every name is set aside (see
      // openHistoryReader and closeHistoryReader). Waiting would hang until those expire.
      if (pool.held === 0)
        throw new Error(`history: every history reader name this connection has on ${stream} is set aside, held by a consumer it did not create (another process using the same credential, or one that stopped mid-read) or by a reader it could not confirm deleted; they expire ${HISTORY_READER_INACTIVE_MS / 60_000} minutes after their last use`);
      const waitOn = pool;
      await new Promise<void>((resolve, reject) => {
        const wake = () => { signal?.removeEventListener("abort", stop); resolve(); };
        const stop = () => { waitOn.waiting.splice(waitOn.waiting.indexOf(wake), 1); reject(abortReason(signal)); };
        waitOn.waiting.push(wake);
        signal?.addEventListener("abort", stop, { once: true });
      });
    }
  }


  /** Give a read's history-reader name back and wake one read waiting for a name. A name whose
   *  delete failed is set aside instead. */
  releaseHistoryReader(reader: HistoryReader): void {
    if (!reader.held) return;
    reader.held = false;
    const pool = reader.pool;
    pool.held--;
    if (!reader.left) { pool.free.push(reader.slot); pool.waiting.shift()?.(); return; }
    this.setAsideHistoryReader(pool, reader.slot);
    // Every waiter checks again, so one that no running read can now serve fails instead of hanging.
    if (pool.held === 0) for (const wake of pool.waiting.splice(0)) wake();
  }


  /** Keep `slot` out of use until a consumer under it would have expired, then free it. */
  setAsideHistoryReader(pool: HistoryReaderSlots, slot: number): void {
    setTimeout(() => { pool.free.push(slot); pool.waiting.shift()?.(); }, HISTORY_READER_INACTIVE_MS).unref();
  }


  /** Create the reader consumer for one step of a read, under the read's name. It is a plain pull
   *  consumer: an nats.js ordered consumer renames itself on every rebuild, and the observer and admin
   *  credentials may delete only these exact names.
   *
   *  Every create carries a fresh description. NATS answers a create whose config equals the existing
   *  consumer's with that consumer, delivery state and all (measured on nats-server 2.15), and a read
   *  repeats the same config on the same name. Without the description a reader left under the name
   *  would come back as if new: a `DeliverPolicy.Last` reader that already delivered its message
   *  reports nothing pending, which reads as an empty channel. With it, a create on a name in use is
   *  refused, and a consumer that does not carry this step's description is never used.
   *
   *  A consumer already under the name is never deleted, whoever left it: another holder of this
   *  credential, a process that stopped mid-read, or this endpoint when a delete's answer was lost and
   *  the name was taken again since. The read moves to a free name, and the taken one stays out of use
   *  until such a consumer would have expired. */
  async openHistoryReader(reader: HistoryReader, config: Partial<ConsumerConfig>): Promise<Consumer> {
    // A single filter must ride the filter-bearing API subject so scoped read grants apply.
    if (config.filter_subjects?.length === 1) {
      const { filter_subjects, ...rest } = config;
      config = { ...rest, filter_subject: filter_subjects[0] };
    }
    const pool = reader.pool;
    for (;;) {
      // A reconnect under the auth callout moved this connection to new reader names, and its
      // credential may no longer delete this one. Creating under it would leave the reader behind.
      if (this.historyReaderId(reader.nc) !== pool.readerId)
        throw new Error(`history: the connection was re-established during the read on ${reader.stream}, so its history reader names changed; the read is not served`);
      const description = `cotal history read ${randomUUID()}`;
      let info: ConsumerInfo | undefined;
      try {
        info = await reader.jsm.consumers.add(reader.stream, {
          ...config,
          name: reader.name,
          description,
          ack_policy: AckPolicy.None,
          max_deliver: 1,
          mem_storage: true,
          num_replicas: 1,
          inactive_threshold: nanos(HISTORY_READER_INACTIVE_MS),
        });
      } catch (e) {
        if (!isConsumerAlreadyExists(e)) throw e;
      }
      if (info?.config.description === description) return reader.js.consumers.getConsumerFromInfo(info);
      this.setAsideHistoryReader(pool, reader.slot);
      const next = pool.free.pop();
      if (next === undefined) {
        // The read ends holding no name. Every waiter checks again, so one that no running read can
        // now serve fails instead of hanging.
        reader.held = false;
        pool.held--;
        for (const wake of pool.waiting.splice(0)) wake();
        throw new Error(`history: reader ${reader.name} on ${reader.stream} is held by a consumer this read did not create, and no other reader name is free`);
      }
      reader.slot = next;
      reader.name = historyReaderConsumer(pool.readerId, next);
    }
  }


  /** Delete the read's reader consumer; already gone is the same outcome. A failed delete may still
   *  have run with its answer lost, and the name may be taken again before this endpoint could tell,
   *  so the name is set aside when the read gives it back rather than deleted again later. A refused
   *  delete means the credential was minted before the observer and admin profiles held their reader
   *  deletes. Each read would then leave a reader for the inactive threshold, which is how a polling
   *  dashboard filled the stream's consumer limit (#4123), so the read fails and says to remint
   *  rather than leak quietly, and reads on the stream fail at once until that reader expires. */
  async closeHistoryReader(reader: HistoryReader): Promise<void> {
    try { await reader.jsm.consumers.delete(reader.stream, reader.name); }
    catch (e) {
      if (isConsumerNotFound(e)) return;
      reader.left = true;
      // No `cause`: a permission-shaped cause would let streamHistory read this as the admin-only
      // DM denial and return an empty page.
      if (this.deps.isPublishPermissionDenied(e)) {
        if (this.historyReaderId(reader.nc) !== reader.pool.readerId)
          throw new Error(`history: the connection was re-established during the read on ${reader.stream}, so it may no longer delete its reader ${reader.name}, which expires on its own; the read is not served`);
        reader.pool.refusedUntil = Date.now() + HISTORY_READER_INACTIVE_MS;
        throw this.readerDeleteRefused(reader.stream);
      }
      throw e;
    }
  }


  readerDeleteRefused(stream: string): Error {
    return new Error(`history: this credential may not delete its own history readers on ${stream}; it predates the observer and admin reader-delete grant, so remint it`);
  }


  /** The newest stream sequence matching `subject`, or 0 when the subject has no messages.
   *
   *  One reader consumer at `DeliverPolicy.Last` with this subject's filter: its `num_pending`
   *  (available from the create, before anything is delivered) is 0 for an empty subject, and
   *  otherwise one message carries the sequence. Same CREATE/INFO/NEXT/DELETE surface `drainWindow`
   *  already uses, so no broker authority is added. */
  async lastMatchingSeq(
    reader: HistoryReader,
    subjects: string[],
    signal?: AbortSignal,
  ): Promise<number> {
    signal?.throwIfAborted();
    const consumer = await this.openHistoryReader(reader, {
      filter_subjects: subjects,
      deliver_policy: DeliverPolicy.Last,
    });
    try {
      // Bind-time zero is the ONLY thing that means "this subject has no messages".
      if ((await consumer.info(true)).num_pending === 0) return 0;
      signal?.throwIfAborted();
      const iter = await consumer.fetch({ max_messages: 1 });
      const stop = () => iter.stop(abortReason(signal));
      signal?.addEventListener("abort", stop, { once: true });
      try {
        signal?.throwIfAborted();
        for await (const m of iter) return m.seq;
      } finally {
        signal?.removeEventListener("abort", stop);
        iter.stop();
      }
      // Bind said a message was pending and none arrived. The pinned client's pull iterator ends
      // CLEANLY when the connection closes ("we don't propagate the error here"), so this is what a
      // dropped link looks like from here. Returning 0 would make the caller report an empty
      // channel, which is the same "could not read means no history" lie the narrowed catch above
      // exists to stop.
      throw new Error(`history: the broker reported messages on ${subjectLabel(subjects)} but delivered none - the read was cut short, not empty`);
    } finally {
      await this.closeHistoryReader(reader);
    }
  }


  /** The oldest stream sequence matching `subject`, or 0 when the subject has no messages.
   *  Mirror of {@link lastMatchingSeq}: same CREATE/INFO/NEXT/DELETE surface, `DeliverPolicy.All`
   *  instead of `Last`, first delivered seq instead of last. Read credentials already hold this. */
  async firstMatchingSeq(
    reader: HistoryReader,
    subjects: string[],
    signal?: AbortSignal,
  ): Promise<number> {
    signal?.throwIfAborted();
    const consumer = await this.openHistoryReader(reader, {
      filter_subjects: subjects,
      deliver_policy: DeliverPolicy.All,
    });
    try {
      if ((await consumer.info(true)).num_pending === 0) return 0;
      signal?.throwIfAborted();
      const iter = await consumer.fetch({ max_messages: 1 });
      const stop = () => iter.stop(abortReason(signal));
      signal?.addEventListener("abort", stop, { once: true });
      try {
        signal?.throwIfAborted();
        for await (const m of iter) return m.seq;
      } finally {
        signal?.removeEventListener("abort", stop);
        iter.stop();
      }
      throw new Error(`history: the broker reported messages on ${subjectLabel(subjects)} but delivered none - the read was cut short, not empty`);
    } finally {
      await this.closeHistoryReader(reader);
    }
  }


  /** Drain every message matching `subject` with sequence in `[start, ceiling]`, oldest-first.
   *  One reader consumer, one batched pull — `AckPolicy.None`, so no per-message ack
   *  round trip. Fetches exactly the pending count so it returns as soon as the window is
   *  delivered rather than blocking for the pull's full expiry. */
  async drainWindow(
    reader: HistoryReader,
    subjects: string[],
    start: number,
    ceiling: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<{ seq: number; subject: string; msg: HistoryMessage }[]> {
    signal?.throwIfAborted();
    const out: { seq: number; subject: string; msg: HistoryMessage }[] = [];
    const consumer = await this.openHistoryReader(reader, {
      filter_subjects: subjects,
      deliver_policy: DeliverPolicy.StartSequence,
      opt_start_seq: start,
    });
    try {
      // A freshly created consumer already carries its ConsumerInfo, so read the CACHED copy: the
      // explicit uncached `info()` this used to call was a round trip for data we already had.
      const pending = (await consumer.info(true)).num_pending;
      if (pending === 0) return out;
      signal?.throwIfAborted();
      // Keep only a small rolling buffer in flight. Stopping a client iterator cannot unsend bytes the
      // broker already committed to that pull request, so fetching the whole page let an aborted history
      // read keep filling a constrained shared connection and starve the next dashboard poll. `consume`
      // replenishes this bounded buffer as it is read, so large pages still complete without committing
      // all of their bytes to the connection up front.
      const iter = await consumer.consume({ max_messages: Math.min(pending, 32) });
      const stop = () => iter.stop(abortReason(signal));
      signal?.addEventListener("abort", stop, { once: true });
      // PROVE THE WINDOW COMPLETED. The pull iterator ends cleanly on a dropped connection, so a
      // close after three of ten deliveries would otherwise return a convincing three-message page.
      // The window is done when we have reached its upper bound or consumed everything bind said
      // was pending; anything else is a cut-short read and must say so.
      let delivered = 0;
      let complete = false;
      try {
        signal?.throwIfAborted();
        for await (const m of iter) {
          delivered++;
          // A plain consumer does not rebuild itself the way an ordered one did, so a gap in its
          // delivery sequence is a message this page would silently lack.
          if (m.info.deliverySequence !== delivered)
            throw new Error(`history: delivery ${m.info.deliverySequence} arrived where ${delivered} was due on ${subjectLabel(subjects)} - the window has a gap, so the page is not served`);
          if (m.seq >= ceiling) { // reached the page's upper bound
            if (m.seq === ceiling) {
              const msg = this.deps.decodeHistory(m);
              if (msg) out.push({ seq: m.seq, subject: m.subject, msg });
            }
            complete = true;
            break;
          }
          const msg = this.deps.decodeHistory(m);
          if (msg) {
            out.push({ seq: m.seq, subject: m.subject, msg });
            if (out.length > limit) out.shift();
          }
          if (delivered >= pending) { complete = true; break; }
        }
      } finally {
        signal?.removeEventListener("abort", stop);
        iter.stop();
      }
      if (!complete)
        throw new Error(`history: read ${delivered} of ${pending} messages on ${subjectLabel(subjects)} before the stream ended early - the window was cut short, not empty`);
      return out;
    } finally {
      // DELETE THE READER. Left alone it would stay for its inactive threshold, and the widening
      // search can run several steps per call while a polling dashboard repeats every call on each
      // poll. The observer and admin profiles used to hold no delete at all (#691), so a dashboard
      // polling every ten seconds filled the stream's consumer limit and every later read failed
      // (#4123). Each reader now goes when its step ends.
      await this.closeHistoryReader(reader);
    }
  }


  /**
   * Read retained chat history on ONE channel subject through a name-scoped, single-filter
   * EPHEMERAL pull consumer — the broker-contained replacement for the removed Direct Get. The
   * create rides `$JS.API.CONSUMER.CREATE.<CHAT>.<chathist_id>.<subject>`, whose trailing filter
   * token nats-server pins to the request body (JSConsumerCreateFilterSubjectMismatchErr, code
   * 10131) — so an agent can only ever replay a channel its `allowSubscribe` grants. Single filter
   * only (plural isn't ACL-constrainable); `AckPolicy.None` + `mem_storage` so it leaves no durable
   * state, and it is deleted right after. Returns raw messages in stream order from `start`,
   * stopping once past `untilSeq` (exclusive of it) or after `limit`. The per-instance name means
   * calls must be serial — every reader here awaits to completion, so they are.
   */
  async collectHistory(
    subject: string,
    start: { seq: number } | { time: Date },
    opts: { untilSeq?: number; limit?: number } = {},
  ): Promise<JsMsg[]> {
    // Serialize on the per-instance lock: the fixed `chathist_<id>` name means two concurrent reads
    // (recall + join-backfill + drop-marker can race in-process) would delete/recreate the consumer
    // under each other and cross-feed results. The chain makes the "serial callers" assumption true.
    const run = this.histLock.then(() => this.collectHistoryInner(subject, start, opts));
    this.histLock = run.catch(() => {}); // keep the chain alive on error
    return run;
  }


  async collectHistoryInner(
    subject: string,
    start: { seq: number } | { time: Date },
    opts: { untilSeq?: number; limit?: number } = {},
  ): Promise<JsMsg[]> {
    if (!this.jsm || !this.js) throw new Error(this.deps.notLiveMsg());
    const stream = chatStream(this.space);
    const name = chatHistDurable(this.owner, this.actor, this.deps.requireLifecycleUid("chat history reads"));
    const out: JsMsg[] = [];
    // Clear any consumer leaked by a crashed prior read before re-creating it with THIS read's
    // single filter (the read ACL is enforced at create — see the doc above).
    await this.deps.deleteConsumerIfPresent(stream, name);
    await this.jsm.consumers.add(stream, {
      name,
      filter_subject: subject,
      ack_policy: AckPolicy.None,
      mem_storage: true,
      inactive_threshold: nanos(30_000),
      ...("time" in start
        ? { deliver_policy: DeliverPolicy.StartTime, opt_start_time: start.time.toISOString() }
        : { deliver_policy: DeliverPolicy.StartSequence, opt_start_seq: start.seq }),
    });
    try {
      const consumer = await this.js.consumers.get(stream, name);
      let pending = (await consumer.info()).num_pending;
      while (pending > 0) {
        const want = Math.min(pending, 256);
        const iter = await consumer.fetch({ max_messages: want, expires: 5_000 });
        let got = 0;
        for await (const m of iter) {
          got++;
          if (opts.untilSeq !== undefined && m.seq > opts.untilSeq) return out; // crossed the frontier
          // Belt-and-suspenders over the lock: only keep messages on the requested channel subject
          // (the consumer's filter already bounds this; guards against any stale-consumer edge).
          if (!subjectMatches(subject, m.subject)) continue;
          out.push(m);
          if (opts.limit !== undefined && out.length >= opts.limit) return out;
        }
        if (got < want) break; // drained early
        pending -= got;
      }
    } finally {
      await this.deps.deleteConsumerIfPresent(stream, name);
    }
    return out;
  }


  /** Read a channel's retained history up to `upToSeq` (the join frontier) and emit each message
   *  as a `historical` "message" event. `sinceMs` bounds how far back via a native consumer
   *  `start_time` (now − window); unset ⇒ the full retained window. `floorSeq`, when set, is a
   *  tighter lower bound than the window: this incarnation had already consumed everything up to
   *  and including it before a preservation cut, so the read starts at `floorSeq + 1` and the
   *  `sinceMs` window is not consulted (the floor is the tighter bound by construction — the seat
   *  was live for the window's tail). `floorSeq >= upToSeq` means there is nothing new to read at
   *  all; return 0 without creating a consumer. A floor below the stream's oldest retained sequence
   *  is fine: JetStream's `DeliverPolicy.StartSequence` begins at the first retained message at or
   *  after it, which is exactly the catch-up. New messages (`seq > upToSeq`) are skipped — the live
   *  tail owns them. Reads through the contained {@link collectHistory}. */
  async backfillChannel(channel: string, upToSeq: number, sinceMs?: number, floorSeq?: number): Promise<number> {
    if (floorSeq !== undefined && floorSeq >= upToSeq) return 0;
    const subject = chatSubject(this.space, "*", "*", channel);
    // A window that reaches back before 1970 covers the whole retained window (#7323). Its start time
    // would be a date JetStream does not read, or not a valid date at all, and the read replayed nothing.
    const since = sinceMs === undefined ? undefined : Date.now() - sinceMs;
    const start =
      floorSeq !== undefined ? { seq: floorSeq + 1 } : since === undefined || !(since > 0) ? { seq: 1 } : { time: new Date(since) };
    const noop: Delivery = { ack: () => {}, nak: () => {}, durable: false };
    if (this.mediated(channel)) {
      // The daemon authenticated each row's sender from its subject, as the direct path checks below.
      let rows: { seq: number; message: CotalMessage }[];
      try {
        rows = await this.readRange(channel, { fromSeq: floorSeq !== undefined ? floorSeq + 1 : 1, untilSeq: upToSeq, ...(floorSeq === undefined && sinceMs !== undefined ? { sinceMs } : {}) });
      } catch (e) {
        // As on the direct path below: a refusal throws, and only a request that went unanswered
        // reads as nothing backfilled.
        this.deps.emit("error", e as Error);
        if (e instanceof MediatedReadRefused) throw e;
        return 0;
      }
      let n = 0;
      for (const { message } of rows) {
        if (message.from.id === this.card.id) continue;
        this.deps.emit("message", message, noop, { historical: true, kind: "channel" } satisfies MessageMeta);
        n++;
      }
      return n;
    }
    let msgs: JsMsg[];
    try {
      msgs = await this.collectHistory(subject, start, { untilSeq: upToSeq });
    } catch (e) {
      this.deps.emit("error", e as Error);
      if (isPermissionDenied(e)) throw e;
      return 0;
    }
    let n = 0;
    for (const sm of msgs) {
      let msg: CotalMessage;
      try {
        msg = sm.json<CotalMessage>();
      } catch {
        continue; // skip undecodable
      }
      // Same authenticity guard as the tail; skip our own echoes in history.
      if (!this.deps.isRecord(msg) || !this.deps.isUsableMessageId(msg.id)) continue; // malformed envelope (SPEC sec 5) — history skips
      const parsed = parseSubject(sm.subject);
      if (!parsed || !this.deps.isFromSubjectSender(msg, parsed) || msg.from.id === this.card.id) continue;
      // Backfill only ever reads the chat stream, so the authenticated class is always "channel".
      this.deps.emit("message", this.deps.authenticatedMessage(msg, parsed), noop, { historical: true, kind: "channel" } satisfies MessageMeta);
      n++;
    }
    return n;
  }


  /**
   * Replay-gated pull of a channel's retained ambient from `sinceSeq` (exclusive) forward — the
   * focus-recall read behind `cotal_inbox`. Returns the messages (NOT emitted — this is a pull,
   * not a push into context) plus `dropped: true` when the window may not be complete: the stream's
   * limits may have removed posts after the watermark ({@link chatMayHaveLost}: a sender at the
   * per-sender limit, or the stream's oldest post already past the watermark), or replay is off
   * for the channel below. Either way the caller must say so rather than silently reporting an
   * empty, complete window. `seqs[i]` is the chat
   * stream sequence of `messages[i]`, the one identity two identical messages do not share.
   * `unanswered` is true when no history read answered (replay is off, or the read failed), so
   * `messages` says nothing about what the channel retains.
   *
   * Honors the **same** per-channel replay gate as join-backfill ({@link joinPolicyFresh}): a
   * `replay=off` channel returns no messages, so `focus` can't become a history bypass for a
   * channel that denies replay to everyone else (the read ACL bounds *which* channels recall can
   * touch; this app gate bounds *whether* a permitted channel replays). Ingest still ack-drops
   * focus-mode ambient/mentions on this channel on the promise that they stay recallable (#977) —
   * the gate means that promise cannot be kept, so it reports `dropped: true` rather than pretend
   * the window was empty and complete.
   */
  async recallChannel(
    channel: string,
    sinceSeq: number,
  ): Promise<{ messages: CotalMessage[]; seqs: number[]; dropped: boolean; unanswered: boolean }> {
    if (!this.jsm) throw new Error(this.deps.notLiveMsg());
    if (!isConcreteChannel(channel)) return { messages: [], seqs: [], dropped: false, unanswered: true };
    const policy = await this.deps.joinPolicyFresh(channel);
    if (!policy.replay) return { messages: [], seqs: [], dropped: true, unanswered: true };
    const collected: CotalMessage[] = [];
    const seqs: number[] = [];
    if (this.mediated(channel)) {
      try {
        for (const { seq, message } of await this.readRange(channel, { fromSeq: sinceSeq + 1 })) {
          if (message.from.id === this.card.id) continue;
          collected.push(message);
          seqs.push(seq);
        }
      } catch (e) {
        this.deps.emit("error", e as Error);
        if (e instanceof MediatedReadRefused) throw e;
        return { messages: [], seqs: [], dropped: true, unanswered: true };
      }
      return this.recallVerdict(channel, sinceSeq, collected, seqs);
    }
    const subject = chatSubject(this.space, "*", "*", channel);
    let raw: JsMsg[];
    try {
      raw = await this.collectHistory(subject, { seq: sinceSeq + 1 });
    } catch (e) {
      this.deps.emit("error", e as Error);
      if (isPermissionDenied(e)) throw e;
      return { messages: [], seqs: [], dropped: true, unanswered: true };
    }
    for (const sm of raw) {
      let msg: CotalMessage;
      try {
        msg = sm.json<CotalMessage>();
      } catch {
        continue; // skip undecodable
      }
      // Same authenticity guard as the tail/backfill; skip our own echoes.
      if (!this.deps.isRecord(msg) || !this.deps.isUsableMessageId(msg.id)) continue; // malformed envelope (SPEC sec 5) — recall skips
      const parsed = parseSubject(sm.subject);
      if (!parsed || !this.deps.isFromSubjectSender(msg, parsed) || msg.from.id === this.card.id) continue;
      collected.push(this.deps.authenticatedMessage(msg, parsed));
      seqs.push(sm.seq);
    }
    return this.recallVerdict(channel, sinceSeq, collected, seqs);
  }


  /** Attach the completeness verdict to a recall read. */
  private async recallVerdict(
    channel: string,
    sinceSeq: number,
    messages: CotalMessage[],
    seqs: number[],
  ): Promise<{ messages: CotalMessage[]; seqs: number[]; dropped: boolean; unanswered: boolean }> {
    let dropped: boolean;
    try {
      dropped = await this.deps.chatMayHaveLost(channel, sinceSeq);
    } catch (e) {
      // Completeness could not be read, so the read is reported as unanswered: nothing settles on it.
      this.deps.emit("error", e as Error);
      if (isPermissionDenied(e)) throw e;
      return { messages: [], seqs: [], dropped: true, unanswered: true };
    }
    return { messages, seqs, dropped, unanswered: false };
  }
}
