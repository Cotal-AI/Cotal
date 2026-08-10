import { Bucket, KvWatchInclude } from "@nats-io/kv/internal";
import type { KV, KvEntry, KvWatchEntry } from "@nats-io/kv";

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
export async function liveKvEntries(kv: KV, filter?: string | string[]): Promise<KvEntry[]> {
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
  try {
    // THE BIND-TIME PROOF, continued: zero here is the only thing that yields an empty result.
    expected = (await oc.info(true)).num_pending;
    if (expected === 0) return [];

    // Greatest revision per key, markers INCLUDED — see the header. Collapsing after the fact is
    // what makes concurrent rewrites and drifted `history` settings both correct.
    const iter = await oc.consume();
    try {
      for await (const m of iter) {
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
      iter.stop();
    }
  } finally {
    await oc.delete().catch(() => { /* already gone, or denied: nothing to reclaim */ });
  }
  // Fell out without the terminal message: the connection dropped, the consumer was removed, or the
  // stream stalled past the heartbeat. Whatever the cause, this is a PARTIAL view and saying so is
  // the whole point. Filtered and unfiltered obey the same rule, including zero-received.
  if (!sawTerminal) throw new IncompleteKvScan(bucketName, received, expected);

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
  filter?: string | string[],
): Promise<T[]> {
  const out: T[] = [];
  for (const e of await liveKvEntries(kv, filter)) {
    const v = decode(e);
    if (v !== undefined) out.push(v);
  }
  return out;
}
