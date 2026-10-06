import { Bucket, KvWatchInclude } from "@nats-io/kv/internal";
import type { KV, KvEntry, KvWatchEntry } from "@nats-io/kv";
import { JetStreamApiCodes, JetStreamApiError, type ConsumerAPI, type ConsumerInfo, type MsgRequest, type NextMsgRequest } from "@nats-io/jetstream";
import { isPublishPermissionDenied } from "./endpoint.js";

/**
 * The ONE sanctioned way to read every live entry of a KV bucket.
 *
 * ## Why this exists
 *
 * Four call sites independently open-coded a whole-bucket read. `readMembership` had the worst
 * shape: enumerate keys, then fetch each key's value. `kv.keys()` is one ordered-consumer pass, but
 * every yielded key then costs a separate `STREAM.MSG.GET` round trip, sequentially. That is O(N)
 * round trips to read N records. It is invisible against a loopback broker and catastrophic anywhere
 * else: 89 membership keys measured 30-34 seconds against a mesh at 534ms RTT, where a single pass is
 * ~3 round trips regardless of N.
 *
 * The other three were already close to a single pass; what they gained is the completeness
 * guarantee below, which none of them had.
 *
 * Fixing the call sites one at a time guarantees a fifth, so no call site may open-code this. That is
 * currently a CONVENTION, not an enforced rule: nothing in the build rejects a new `keys()`-then-
 * `get()` loop.
 *
 * ## Why it owns the pass instead of wrapping `kv.history()`
 *
 * `kv.history()` would deliver values in one pass, but its public iterator does not expose the
 * consumer's `num_pending`. Without it, a caller cannot distinguish an EMPTY bucket from a pass that
 * died before its first message — both arrive as zero entries and a clean end. For membership and
 * ACL reads that ambiguity produces a confident empty set, which is worse than a short one because
 * nothing about it looks wrong.
 *
 * ## What the completeness check guarantees
 *
 * In `@nats-io/kv`, `iter.closed().then(...)` ends an iterator CLEANLY on any mid-stream
 * termination: a dropped connection, a deleted consumer, a server error. Nothing throws. On exactly
 * the high-latency, jittery links this helper exists to serve, a silently truncated read would
 * otherwise be the default failure mode.
 *
 * MEASURED, not inferred. Against `@nats-io/kv` 3.4.0 and a real broker, with the link destroyed
 * mid-delivery through a TCP proxy: `history()` on a bucket of 1500 records returned 20 of them,
 * threw nothing, and ended its iterator exactly as a complete read does. Reported upstream as
 * https://github.com/nats-io/nats.js/issues/426. If that is fixed, this can go back to the public
 * API and drop the `@nats-io/kv/internal` import below; until then the import is load-bearing,
 * because `history()` cannot express the difference between a short answer and a wrong one.
 * Re-run that check on any client bump rather than assuming the behaviour still holds.
 *
 * Because the pass is bound here, both halves are decidable:
 *   - EMPTY is proven, not inferred. `num_pending` is read at bind, before any delivery, so an empty
 *     result means the bucket (or the filtered subset) really had nothing — never that the pass died
 *     before its first message. That distinction is why this does not wrap `history()`, which hides
 *     the count: read through that, a dropped link during a filtered ACL scan reported a provisioned
 *     principal as having no row, and a durable join was refused as "not provisioned".
 *   - COMPLETE means a delivered message reported nothing behind it. An idle heartbeat is NOT
 *     accepted as completion, unlike `history()`, whose "a heartbeat means we got all the keys"
 *     shortcut is how a stalled pass returns a short list wearing a clean end.
 *
 * Anything else raises {@link IncompleteKvScan}. Treat it as retryable: it says this read did not
 * finish, never that data was lost.
 *
 * ## Why tombstones are carried through the collapse
 *
 * Filtering DEL/PURGE markers DURING iteration resurrects deleted keys: if a key's PUT is delivered
 * and its later DEL is skipped, the stale PUT survives as the "latest". So the collapse keeps
 * markers, picks the greatest revision per key, and only then drops keys whose final state is a
 * marker.
 *
 * This is required for CONCURRENCY, not merely for misconfigured buckets. `DeliverPolicy.All` chases
 * a moving tail, so a key rewritten while the pass drains legitimately appears at two revisions even
 * on a `history: 1` bucket.
 *
 * ## What it deliberately does NOT do
 *
 * It never asserts `status().history === 1`. Greatest-revision-with-tombstones is correct for every
 * `history >= 1`, so a drifted bucket is read correctly rather than refused; throwing on a read
 * because PROVISIONING drifted would turn a bucket-config problem into a mesh-wide outage. Bucket
 * reconcile is a privileged setup concern and needs `STREAM.UPDATE`, which read credentials do not
 * have and must not be given.
 *
 * ## Grant
 *
 * Same broker authority as the `keys()` + `get()` pair it replaces: one ordered/push consumer over
 * `$KV.<bucket>.>`, differing only in `deliver_policy`. Values are not new authority — the existing
 * `keys()` consumer grant could already request bodies. No ACL widening anywhere.
 */

/** Thrown when a pass ends without reaching its terminal message. The caller decides whether to
 *  retry or surface it; what it may NOT do is treat the partial set as the answer. */
export class IncompleteKvScan extends Error {
  constructor(
    readonly bucket: string,
    readonly received: number,
    readonly expected: number,
  ) {
    super(
      `reading ${bucket} ended after ${received} of ~${expected} entries without reaching the end of the bucket - the connection or consumer died mid-pass. Refusing to return a partial view (a short or empty result here is indistinguishable from a real answer). Retry; if it persists, the link to the broker is dropping.`,
    );
    this.name = "IncompleteKvScan";
  }
}

export interface LiveKvEntriesOptions {
  signal?: AbortSignal;
  /** Runs each delete of the scan's own consumers in place of the plain delete. */
  deleteOwnConsumer?: (stream: string, name: string, del: () => Promise<boolean>) => Promise<boolean>;
  /** Runs with the scan's consumer before its first delivery. nats.js rebuilds that consumer after a
   *  stall or a sequence gap and deletes the predecessor itself, with no hook before the send, so a
   *  caller that must recognise that refused delete (#691) learns the consumer's name here. */
  onConsumer?: (info: ConsumerInfo) => void;
}

/**
 * Every currently-live entry of `kv`, in ONE pass, with values.
 *
 * `filter` narrows the scan to matching keys (NATS subject wildcards), for callers that scan a
 * key prefix rather than the whole bucket. Returns entries whose final operation is a real value;
 * deleted and purged keys are absent.
 *
 * Throws {@link IncompleteKvScan} if the pass is cut short. Returns `[]` for a bucket that is
 * genuinely empty (proven at bind time, not inferred from silence).
 */
export async function liveKvEntries(
  kv: KV,
  filterOrOptions?: string | string[] | LiveKvEntriesOptions,
  options?: LiveKvEntriesOptions,
): Promise<KvEntry[]> {
  let filter: string | string[] | undefined;
  // The three-argument form may deliberately omit the filter: (kv, undefined, options).
  let opts: LiveKvEntriesOptions | undefined = options;
  if (typeof filterOrOptions === "string" || Array.isArray(filterOrOptions)) {
    filter = filterOrOptions;
    opts = options;
  } else if (filterOrOptions && typeof filterOrOptions === "object") {
    opts = filterOrOptions;
  }

  if (opts?.signal?.aborted) {
    throw opts.signal.reason ?? new Error("scan aborted");
  }

  // OWN THE PASS. This deliberately does NOT call `kv.history()`. That helper hides the consumer's
  // bind-time `num_pending`, and without it an empty result is ambiguous: a genuinely empty bucket
  // and a pass that died before its first message look identical. For a FILTERED scan that ambiguity
  // is not academic — `enumerateLiveAclRows` reads this way, so a dropped link mid-scan would report
  // a provisioned principal as having no ACL row at all, and `deliveryJoin` would refuse the join as
  // "not provisioned" rather than as "could not read". A wrong reason on an authorization path.
  //
  // The pinned client exposes what is needed through its `@nats-io/kv/internal` entry point: the
  // `Bucket` implementation carries the JetStream client, the stream name, the consumer-config
  // builder the public watchers use, and the entry decoder. Binding through those keeps this on
  // EXACTLY the ordered push consumer over `$KV.<bucket>.>` that `keys()` and `history()` already
  // use — same subject, same verbs, no new broker authority.
  if (!(kv instanceof Bucket))
    throw new Error(
      `liveKvEntries needs the @nats-io/kv Bucket implementation to bind its own consumer (got ${kv?.constructor?.name ?? typeof kv}). Refusing to fall back to history(), whose hidden bind-time pending count is exactly the ambiguity this exists to remove.`,
    );
  const bucket: Bucket = kv;
  const cc = bucket._buildCC(filter ?? ">", KvWatchInclude.AllHistory, { headers_only: false });
  const oc = await bucket.js.consumers.getPushConsumer(bucket.stream, cc);
  // nats.js rebuilds the consumer after a stall or a sequence gap as `<prefix>_<serial + 1>` and sends
  // that create without awaiting it, so a delete the broker answers first lets the consumer land after
  // cleanup. The client's consumer API is shared by every scan, so this consumer gets its own view of
  // it that records each create. `answered` holds only for the broker's own reply: a timeout or a closed
  // connection rejects the request without saying whether the create landed.
  // The client sets `api` and `name` on every push consumer it returns; the cast only hides them from the type.
  const own = oc as unknown as { api: ConsumerAPI; name: string };
  const api = own.api;
  const owned = [{ name: own.name, answered: Promise.resolve(true) }];
  own.api = Object.assign(Object.create(api) as ConsumerAPI, {
    add: (...args: Parameters<ConsumerAPI["add"]>) => {
      const created = api.add(...args);
      owned.push({ name: args[1].name!, answered: created.then(() => true, (e) => e instanceof JetStreamApiError) });
      return created;
    },
  });

  // THE BIND-TIME PROOF: `num_pending` is how many messages this consumer will deliver, read before
  // a single one arrives. Zero means the bucket (or the filtered subset) really is empty; it is
  // never inferred from silence.
  // ONE try/finally around EVERY exit. The consumer must be reclaimed on the empty path too: an
  // empty read is not rare, it is the normal answer for a filtered ACL miss, and `readAclForAlias`
  // performs TWO of those per unknown principal. `_buildCC` sets a 5s idle heartbeat, so an
  // undeleted consumer lingers until its inactivity threshold; at alias-check churn that piles up on
  // the broker for no reason.
  const latest = new Map<string, KvWatchEntry>();
  let received = 0;
  let sawTerminal = false;
  let bucketName = bucket.bucket;
  let expected = 0;
  let complete = false;
  try {
    // THE BIND-TIME PROOF, continued: zero here is the only thing that yields an empty result.
    const initialInfo = await oc.info(true);
    opts?.onConsumer?.(initialInfo);
    expected = initialInfo.num_pending;

    if (opts?.signal?.aborted) {
      throw opts.signal.reason ?? new Error("scan aborted");
    }

    // Keep the empty path inside this try/finally too. Returning here would commit [] before
    // cleanup finishes, even if a caller aborts while the consumer delete is pending.
    if (expected !== 0) {
      // Greatest revision per key, markers INCLUDED — see the header. Collapsing after the fact is
      // what makes concurrent rewrites and drifted `history` settings both correct.
      const iter = await oc.consume();
      const onAbort = () => {
        iter.stop(opts?.signal?.reason ?? new Error("scan aborted"));
      };
      opts?.signal?.addEventListener("abort", onAbort, { once: true });

      try {
        for await (const m of iter) {
          if (opts?.signal?.aborted) break;
          const e = bucket.jmToWatchEntry(m, false);
          received++;
          bucketName = e.bucket;
          const prior = latest.get(e.key);
          if (prior === undefined || e.revision >= prior.revision) latest.set(e.key, e);
          // The ONLY completion signal accepted: a delivered message that says nothing is left behind
          // it. Unlike `history()`, an idle heartbeat is NOT treated as "we got everything" — that
          // shortcut is precisely how a stalled pass returns a short list wearing a clean end.
          if (m.info.pending === 0) { sawTerminal = true; break; }
        }
      } finally {
        opts?.signal?.removeEventListener("abort", onAbort);
        if (typeof (iter as { close?: () => Promise<unknown> }).close === "function") {
          await (iter as { close: () => Promise<unknown> }).close().catch(() => {});
        } else {
          iter.stop();
        }
      }
    }
    complete = expected === 0 || sawTerminal;
  } finally {
    try {
      // Delete ONLY this scan's own consumers. nats.js deletes only the last predecessor whose create
      // was answered, so a successor superseded while its create was unanswered is deleted by nobody.
      // The iterator is closed, so no create follows; once each one is answered, none can land after
      // its delete. Newest first, because nats.js never deletes that one itself, so a refusal reaches
      // the hook on a subject none of its predecessor deletes shares.
      const answered = await Promise.all(owned.map((c) => c.answered));
      if (owned.at(-1)!.name !== own.name) throw new Error(`scan consumer ${own.name} was not created through the scan's consumer API - the pinned nats.js changed shape`);
      const deleteOwn = opts?.deleteOwnConsumer ?? ((_stream, _name, del) => del());
      let unanswered: string | undefined;
      for (let i = owned.length - 1; i >= 0; i--) {
        const target = owned[i].name;
        try {
          await deleteOwn(bucket.stream, target, () => bucket.jsm.consumers.delete(bucket.stream, target));
        } catch (e) {
          // A profile without the delete row (#691) is refused for every name alike, and the broker
          // reaps those consumers at their inactive_threshold.
          if (isPublishPermissionDenied(e)) break;
          if (!(e instanceof JetStreamApiError && e.code === JetStreamApiCodes.ConsumerNotFound)) throw e;
          if (!answered[i]) unanswered ??= target;
        }
      }
      if (unanswered) throw new Error(`the broker never answered the create of scan consumer ${unanswered}, so it can land after its delete and live until its inactive_threshold`);
    } catch (e) {
      // The scan's own error, its cancellation and IncompleteKvScan are its answer; a cleanup failure
      // replaces only a result.
      if (complete && !opts?.signal?.aborted) throw e;
    }
  }
  if (opts?.signal?.aborted) {
    throw opts.signal.reason ?? new Error("scan aborted");
  }
  // No original scan error was caught or replaced; only a successful empty result waits for
  // cleanup and this final abort check before it can be returned.
  if (expected === 0) return [];
  // Fell out without the terminal message: the connection dropped, the consumer was removed, or the
  // stream stalled past the heartbeat. Whatever the cause, this is a PARTIAL view and saying so is
  // the whole point. Filtered and unfiltered obey the same rule, including zero-received.
  if (!sawTerminal) throw new IncompleteKvScan(bucketName, received, expected);

  const out: KvEntry[] = [];
  for (const e of latest.values()) if (e.operation !== "DEL" && e.operation !== "PURGE") out.push(e);
  return out;
}

/**
 * Every currently-live entry a key filter matches, read WITHOUT a consumer.
 *
 * The same answer as {@link liveKvEntries}, by a different verb: a forward walk of the bucket's
 * backing stream through `STREAM.MSG.GET` with `next_by_subj`, one leader-served read per stored
 * message, starting at sequence 1 and stopping when the stream reports no further match. It exists
 * for principals that hold NO consumer verb on the bucket and never may: the records bucket is a
 * §13.9 authority stream whose consumer surface is an exact, audited list (a consumer-create body is
 * not subject-ACL confinable, nats-server#8274), so a per-run driver credential reads its own run's
 * notice, migration and program keys this way, over the `STREAM.MSG.GET` row it already holds for
 * every point read.
 *
 * COMPLETENESS is by construction rather than by a bind-time count: each read either returns the next
 * stored message at or after the requested sequence, or the stream's own "no message" answer, which is
 * the only thing that ends the walk. A broker failure mid-walk propagates as the error it is; there is
 * no iterator that can end cleanly short of the answer, so a short result cannot wear a clean end.
 *
 * COST is one round trip per matching stored message, so it is for bounded, per-run key families
 * (a run's notices, its migrations, its programs, the run records of a space), never for a bucket
 * whose matching set grows with the mesh. `liveKvEntries` remains the pass for those.
 *
 * Markers are carried through the collapse for the reason the header gives: a bucket with
 * `history > 1` shows a key at several revisions and only the greatest decides.
 */
export async function walkKvEntries(kv: KV, filter: string): Promise<KvEntry[]> {
  if (!(kv instanceof Bucket))
    throw new Error(
      `walkKvEntries needs the @nats-io/kv Bucket implementation to address its backing stream (got ${kv?.constructor?.name ?? typeof kv})`,
    );
  const bucket: Bucket = kv;
  const subject = `${bucket.prefix}.${filter}`;
  const latest = new Map<string, KvEntry>();
  let seq = 1;
  for (;;) {
    let sm;
    try {
      // The client types `next_by_subj` only on its Direct Get request; the STREAM.MSG.GET API takes
      // the same `{seq, next_by_subj}` body (measured on nats-server 2.14.5: walks forward through a
      // wildcard filter and answers "no message" past the last match), so the request is passed as
      // the API's own shape rather than the narrower one the typing declares.
      const req: NextMsgRequest = { seq, next_by_subj: subject };
      sm = await bucket.jsm.streams.getMessage(bucket.stream, req as unknown as MsgRequest);
    } catch (e) {
      // 10037 is the stream saying nothing at or after `seq` matches: the end of the walk. The
      // pinned client answers `null` for it; older ones threw. Every other error is the broker.
      if ((e as { code?: unknown })?.code === 10037) break;
      throw e;
    }
    if (sm === null || sm === undefined) break;
    const e = bucket.smToEntry(sm);
    const prior = latest.get(e.key);
    if (prior === undefined || e.revision >= prior.revision) latest.set(e.key, e);
    seq = sm.seq + 1;
  }
  const out: KvEntry[] = [];
  for (const e of latest.values()) if (e.operation !== "DEL" && e.operation !== "PURGE") out.push(e);
  return out;
}

/** {@link liveKvEntries}, decoded. `decode` returning `undefined` drops the entry — for callers that
 *  skip garbled records rather than failing the whole read (the prevailing convention in the
 *  registries: one unparseable row must not blind the surface to every other row). */
export async function liveKvValues<T>(
  kv: KV,
  decode: (e: KvEntry) => T | undefined,
  filterOrOptions?: string | string[] | LiveKvEntriesOptions,
  options?: LiveKvEntriesOptions,
): Promise<T[]> {
  const out: T[] = [];
  for (const e of await liveKvEntries(kv, filterOrOptions, options)) {
    const v = decode(e);
    if (v !== undefined) out.push(v);
  }
  return out;
}
