import { Bucket, KvWatchInclude } from "@nats-io/kv/internal";
import type { KV, KvEntry, KvWatchEntry } from "@nats-io/kv";

/**
 * The ONE sanctioned way to read every live entry of a KV bucket.
 *
 * ## Why this exists
 *
 * Six-plus call sites independently open-coded the same shape: enumerate keys, then fetch each
 * key's value. `kv.keys()` is one ordered-consumer pass, but every yielded key then costs a separate
 * `STREAM.MSG.GET` round trip, sequentially. That is O(N) round trips to read N records. It is
 * invisible against a loopback broker and catastrophic anywhere else: 89 membership keys measured
 * 30-34 seconds against a mesh at 534ms RTT, where a single pass is ~3 round trips regardless of N.
 *
 * Fixing the call sites one at a time guarantees a seventh, so no call site may open-code this.
 *
 * ## Why it owns the pass instead of wrapping `kv.history()`
 *
 * `kv.history()` would deliver values in one pass, but its public iterator does not expose the
 * consumer's `num_pending`. Without it, a caller cannot distinguish an EMPTY bucket from a pass that
 * died before its first message — both arrive as zero entries and a clean end. For membership and
 * ACL reads that ambiguity produces a confident empty set, which is worse than a short one because
 * nothing about it looks wrong.
 *
 * ## What the completeness check does and does NOT guarantee
 *
 * In `@nats-io/kv`, `iter.closed().then(...)` ends the iterator CLEANLY on any mid-stream
 * termination: a dropped connection, a deleted consumer, a server error. Nothing throws. On exactly
 * the high-latency, jittery links this helper exists to serve, a silently truncated read is the
 * default failure mode. So a pass that delivered entries and then stopped WITHOUT its terminal
 * `pending === 0` sentinel throws rather than returning a partial answer dressed as a complete one.
 *
 * The limits matter, because a guarantee that is believed but not held is worse than none:
 *   - A pass that dies BEFORE its first message cannot be told apart from an empty bucket through
 *     this client's API, and is returned as empty. Closing that needs the helper to bind its own
 *     consumer and read `num_pending` at bind time; today it wraps `history()`, which does not
 *     expose it. That is the honest gap.
 *   - `history()` also ends on an idle heartbeat, which the client reads as "caught up". If the last
 *     initially-pending message is purged before delivery, a HEALTHY pass can end without the
 *     sentinel. The check is conservative in that direction: it can call a healthy read incomplete.
 *     So `IncompleteKvScan` means "retry this", never "data was lost".
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

  // THE BIND-TIME PROOF. `num_pending` here is how many messages this consumer is going to deliver,
  // read before a single one arrives. Zero means the bucket (or the filtered subset) really is
  // empty; it is not inferred from silence.
  const expected = (await oc.info(true)).num_pending;
  if (expected === 0) return [];

  // Greatest revision per key, markers INCLUDED — see the header. Collapsing after the fact is what
  // makes concurrent rewrites and drifted `history` settings both correct.
  const latest = new Map<string, KvWatchEntry>();
  let received = 0;
  let sawTerminal = false;
  let bucketName = bucket.bucket;
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
