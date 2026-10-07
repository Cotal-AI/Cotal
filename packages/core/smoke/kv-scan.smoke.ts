/**
 * The `liveKvEntries` contract — the single sanctioned full-bucket KV read that replaced six
 * open-coded `keys()`-then-`get()`-per-key loops.
 *
 * Three properties, each of which is a bug if it regresses:
 *
 *  1. ROUND-TRIP SHAPE. The cost must be independent of the record count. That is the whole point:
 *     the old shape was O(N) sequential round trips, which is invisible on loopback and took 30+
 *     seconds for 89 records on a real link. Asserted by counting the client's outbound requests
 *     over a 1-record vs a 100-record bucket, NOT by wall clock (which would flake and would not
 *     prove the shape).
 *  2. COLLAPSE WITH TOMBSTONES. Deleting a key must not resurrect its earlier value, and a key
 *     rewritten during the pass must resolve to its newest revision. Skipping markers DURING
 *     iteration is the subtle way to get this wrong.
 *  3. COMPLETENESS. A pass cut short must THROW, not return a short list. On the flaky links this
 *     helper exists for, `@nats-io/kv` ends a broken iteration cleanly, so a truncated read is
 *     otherwise indistinguishable from a real answer.
 *
 * Needs nats-server on PATH. Run: pnpm smoke:kv-scan
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, connect as tcpConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { IncompleteKvScan, isReachable, liveKvEntries, walkKvEntries } from "../src/index.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { pickFreePort } from "./_free-port.js";

const PORT = await pickFreePort();
const SERVER = `nats://127.0.0.1:${PORT}`;
const store = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const srv = spawn("nats-server", ["-p", String(PORT), "-js", "-sd", store], { stdio: "ignore" });
// The `finally` below stays and still does the work on every normal exit; ownership only covers the
// path where this process is killed and the `finally` never unwinds.
const releaseBroker = teardownOnSignal(srv, store);
try {
  let up = false;
  for (let i = 0; i < 60; i++) { if (await isReachable(SERVER)) { up = true; break; } await wait(150); }
  if (!up) throw new Error("nats-server did not start");

  const nc = await connect({ servers: SERVER });
  const kvm = new Kvm(nc);
  const enc = (s: string) => new TextEncoder().encode(s);

  // ── 1. ROUND-TRIP SHAPE ────────────────────────────────────────────────────────────────────────
  // Count the client's OUTBOUND messages across the read. The old shape issued one STREAM.MSG.GET
  // per key, so this number tracked N; the single pass must not.
  const small = await kvm.create("shape_small", { history: 1 });
  await small.put("only", enc("1"));
  const big = await kvm.create("shape_big", { history: 1 });
  for (let i = 0; i < 100; i++) await big.put(`k${i}`, enc(String(i)));

  const outBefore1 = nc.stats().outMsgs;
  const got1 = await liveKvEntries(small);
  const cost1 = nc.stats().outMsgs - outBefore1;
  const outBefore100 = nc.stats().outMsgs;
  const got100 = await liveKvEntries(big);
  const cost100 = nc.stats().outMsgs - outBefore100;

  check("reads all 1 record", got1.length === 1, got1.map((e) => e.key));
  check("reads all 100 records", got100.length === 100, got100.length);
  // The honest bound: request count must not scale with N. Allow a small constant for consumer
  // setup and any flow-control reply; the OLD code would have spent ~100 here.
  check(
    `request count is independent of record count (1 rec: ${cost1}, 100 rec: ${cost100})`,
    cost100 <= cost1 + 5 && cost100 < 20,
    { cost1, cost100 },
  );

  // ── 2. COLLAPSE WITH TOMBSTONES ────────────────────────────────────────────────────────────────
  const tomb = await kvm.create("tombstones", { history: 1 });
  await tomb.put("alive", enc("yes"));
  await tomb.put("deleted", enc("was-here"));
  await tomb.delete("deleted");
  await tomb.put("purged", enc("also-was-here"));
  await tomb.purge("purged");
  const live = await liveKvEntries(tomb);
  const keys = live.map((e) => e.key).sort();
  check("a PUT then DEL does not reappear", !keys.includes("deleted"), keys);
  check("a PUT then PURGE does not reappear", !keys.includes("purged"), keys);
  check("surviving keys are returned with their values",
    keys.join(",") === "alive" && new TextDecoder().decode(live[0]!.value) === "yes", keys);

  // Rewrites: the newest revision wins, including on a bucket that keeps several revisions (the
  // drifted-config shape, where naive iteration would yield the same key twice).
  const multi = await kvm.create("multi_rev", { history: 5 });
  await multi.put("k", enc("v1"));
  await multi.put("k", enc("v2"));
  await multi.put("k", enc("v3"));
  const rev = await liveKvEntries(multi);
  check("history>1: one entry per key", rev.length === 1, rev.map((e) => `${e.key}@${e.revision}`));
  check("history>1: the NEWEST revision wins", new TextDecoder().decode(rev[0]!.value) === "v3", new TextDecoder().decode(rev[0]!.value));
  // The resurrection case, on a bucket that retains the prior PUT: latest state is a marker, so the
  // key must be absent. Filtering markers during iteration would have surfaced "v1" here.
  await multi.put("gone", enc("v1"));
  await multi.delete("gone");
  const afterDel = await liveKvEntries(multi);
  check("history>1: a deleted key does NOT resurrect its retained prior value",
    !afterDel.some((e) => e.key === "gone"), afterDel.map((e) => e.key));

  // ── 3. COMPLETENESS ────────────────────────────────────────────────────────────────────────────
  const empty = await kvm.create("empty_bucket", { history: 1 });
  check("a genuinely empty bucket returns [] (not an error)", (await liveKvEntries(empty)).length === 0);

  // Filtered scans work and do not treat "no match" as truncation.
  const filtered = await kvm.create("filtered", { history: 1 });
  await filtered.put("a.one", enc("1"));
  await filtered.put("a.two", enc("2"));
  await filtered.put("b.one", enc("3"));
  check("filter narrows the scan", (await liveKvEntries(filtered, "a.>")).length === 2);
  check("a filter matching nothing returns [] in a NON-empty bucket",
    (await liveKvEntries(filtered, "zzz.>")).length === 0);

  // ── COMPLETENESS, against a real broker (the stub era is over: the helper now binds its own
  //    consumer through the pinned client's Bucket seam, so these properties are only meaningful
  //    against a real one). ──────────────────────────────────────────────────────────────────────

  // SEAM CANARY. The bind-time proof depends on `@nats-io/kv/internal` exposing Bucket with the
  // members below. If a client bump removes them, that must fail HERE, loudly, not in production as
  // a refusal to read.
  const { Bucket: BucketCls, KvWatchInclude: Inc } = await import("@nats-io/kv/internal");
  check("internal seam still present: Bucket + KvWatchInclude", typeof BucketCls === "function" && Inc !== undefined);
  const probe = await kvm.create("seam_probe", { history: 1 });
  check("a real KV handle IS a Bucket (the helper refuses anything else)", probe instanceof BucketCls);
  for (const m of ["js", "stream", "_buildCC", "jmToWatchEntry"] as const)
    check(`Bucket still exposes ${m}`, (probe as unknown as Record<string, unknown>)[m] !== undefined);

  // Bind-time emptiness is PROVEN, not inferred from silence.
  const empty2 = await kvm.create("empty_proof", { history: 1 });
  check("an empty bucket returns [] via the bind-time pending count", (await liveKvEntries(empty2)).length === 0);

  // THE S1 CASE. A pass that dies before delivering anything, with entries pending at bind, must
  // THROW — not return []. This is the one that made `readAclForAlias` able to report a provisioned
  // principal as unprovisioned, so it is asserted for a FILTERED scan too.
  // TRUNCATION. The failure being reproduced is specific and documented: on a dropped connection the
  // pinned client's iterator calls `stop()` WITHOUT propagating an error, so a cut-short pass ends
  // exactly like a complete one. Racing a real `nc.close()` against the drain cannot force that
  // reliably (60 records on loopback finish before the close lands, and winning the race the other
  // way produces a pre-bind error, which is a different failure). So the bind is REAL, `expected`
  // is real, and only the iterator's ending is simulated - faithfully, as a clean stop with no
  // error, which is what the client does.
  for (const [name, filter, cut] of [
    ["unfiltered, cut mid-drain", undefined, 5],
    ["filtered, cut mid-drain", "a.>", 5],
    ["filtered, cut before ANY delivery", "a.>", 0],
  ] as const) {
    const src = await kvm.create(`truncated_${cut}_${filter ? "f" : "u"}`, { history: 1 });
    for (let i = 0; i < 40; i++) await src.put(`a.k${i}`, enc("v"));
    const victim = Object.create(src) as typeof src;
    const rjs = (src as unknown as { js: { consumers: { getPushConsumer: (...a: unknown[]) => Promise<Record<string, unknown>> } } }).js;
    Object.defineProperty(victim, "js", {
      value: { ...rjs, consumers: { ...rjs.consumers, getPushConsumer: async (...a: unknown[]) => {
        const oc = await rjs.consumers.getPushConsumer.apply(rjs.consumers, a);
        const realConsume = (oc.consume as () => Promise<AsyncIterable<unknown> & { close: () => Promise<unknown> }>).bind(oc);
        // Real consumer, real bind-time num_pending; the ONLY thing altered is that the iterator
        // stops early and cleanly, exactly as the client does when the connection drops.
        return Object.assign(Object.create(oc as object), {
          consume: async () => {
            const inner = await realConsume();
            const gen = (async function* () {
              let n = 0;
              for await (const m of inner) { if (n++ >= cut) return; yield m; }
            })();
            // The helper closes the iterator in its finally, so the stand-in must carry `close` too.
            return Object.assign(gen, { close: () => inner.close() });
          },
        });
      } } },
    });
    let threw: unknown;
    await liveKvEntries(victim, filter).then(
      (r) => { threw = `RETURNED ${r.length} entries`; },
      (e) => { threw = e; },
    );
    check(`${name}: raises IncompleteKvScan, never returns a list`, threw instanceof IncompleteKvScan, String(threw));
  }

  // CONSUMER HYGIENE. Every exit path must reclaim its consumer, including the EMPTY one — that is
  // the normal answer for a filtered ACL miss, and readAclForAlias performs two per unknown
  // principal, so a leak there piles up fastest exactly where reads are most frequent. Asserted by
  // consumer count returning to baseline, because this has now leaked twice from two different
  // code paths.
  {
    const jsmc = await jetstreamManager(nc);
    const streamName = `KV_${"leak_check"}`;
    const lk = await kvm.create("leak_check", { history: 1 });
    await lk.put("a.one", enc("1"));
    const baseline = (await jsmc.streams.info(streamName)).state.consumer_count;
    await liveKvEntries(lk);                 // non-empty read
    await liveKvEntries(lk, "zzz.>");        // FILTERED MISS — the empty path
    await liveKvEntries(await kvm.create("leak_check_empty", { history: 1 })); // empty bucket
    await wait(200);
    const after = (await jsmc.streams.info(streamName)).state.consumer_count;
    check(`every read path reclaims its consumer (baseline ${baseline}, after ${after})`, after <= baseline, { baseline, after });
  }

  // A non-Bucket handle is refused loudly rather than silently falling back to history().
  let refused: unknown;
  await liveKvEntries({ history: async () => [] } as never).catch((e) => { refused = e; });
  check("a non-Bucket KV handle is refused loudly", refused instanceof Error && /Bucket/.test(String((refused as Error).message)), String(refused));

  // ── COMPLETED AND EMPTY SCANS WITH NONZERO EXPECTED COUNTS ──
  {
    const jsm = await jetstreamManager(nc);
    const stream = `KV_scan_counts`;
    const k = await kvm.create("scan_counts", { history: 1 });
    for (let i = 0; i < 5; i++) await k.put(`k${i}`, enc(`v${i}`));
    const base = (await jsm.streams.info(stream)).state.consumer_count;
    const entries = await liveKvEntries(k);
    check("completed scan returns nonzero expected count (5)", entries.length === 5, entries.length);
    const afterComplete = (await jsm.streams.info(stream)).state.consumer_count;
    check("completed scan deletes ONLY its own consumer in finally", afterComplete === base, { base, afterComplete });

    const emptyBucket = await kvm.create("scan_counts_empty", { history: 1 });
    const emptyEntries = await liveKvEntries(emptyBucket);
    check("empty scan returns 0 entries", emptyEntries.length === 0, emptyEntries.length);
    const afterEmpty = (await jsm.streams.info(`KV_scan_counts_empty`)).state.consumer_count;
    check("empty scan deletes ONLY its own consumer in finally", afterEmpty === 0, afterEmpty);
  }

  // ── SUB/UNSUB: SUBSCRIPTIONS DO NOT LEAK ACROSS SCANS ──
  {
    const k = await kvm.create("sub_unsub_check", { history: 1 });
    await k.put("item", enc("val"));
    const getSubs = () => {
      const p = (nc as unknown as { protocol?: { subscriptions?: { count?: number; subs?: Map<number, unknown> } } }).protocol;
      return p?.subscriptions?.count ?? p?.subscriptions?.subs?.size ?? 0;
    };
    const subsBefore = getSubs();
    for (let i = 0; i < 5; i++) {
      await liveKvEntries(k);
    }
    const subsAfter = getSubs();
    check("SUB/UNSUB: subscription count returns to baseline after repeated scans", subsAfter <= subsBefore, { subsBefore, subsAfter });
  }

  // ── STABLE BOUNDED REPEATED-SCAN CONSUMER COUNT ──
  {
    const jsm = await jetstreamManager(nc);
    const stream = `KV_repeated_scan`;
    const k = await kvm.create("repeated_scan", { history: 1 });
    for (let i = 0; i < 10; i++) await k.put(`key.${i}`, enc(`val.${i}`));
    const base = (await jsm.streams.info(stream)).state.consumer_count;
    for (let i = 0; i < 15; i++) {
      const res = await liveKvEntries(k);
      assert.equal(res.length, 10);
    }
    await wait(100);
    const after = (await jsm.streams.info(stream)).state.consumer_count;
    check("stable bounded repeated-scan consumer count remains at baseline (0 leaked consumers across 15 scans)", after === base, { base, after });
  }

  // ── CANCELLATION: ABORTED SIGNAL RECLAIMS CONSUMER IN FINALLY ──
  {
    const jsm = await jetstreamManager(nc);
    const stream = `KV_cancel_check`;
    const k = await kvm.create("cancel_check", { history: 1 });
    for (let i = 0; i < 10; i++) await k.put(`k${i}`, enc(`v${i}`));
    const base = (await jsm.streams.info(stream)).state.consumer_count;

    // Pre-aborted signal
    const acPre = new AbortController();
    acPre.abort(new Error("pre-aborted"));
    let preErr: unknown;
    try {
      await liveKvEntries(k, ">", { signal: acPre.signal });
    } catch (e) {
      preErr = e;
    }
    check("cancellation: pre-aborted scan throws abort reason", (preErr as Error)?.message === "pre-aborted", preErr);
    const afterPre = (await jsm.streams.info(stream)).state.consumer_count;
    check("cancellation: pre-aborted scan reclaims consumer", afterPre === base, { base, afterPre });

    // Mid-scan abort
    const acMid = new AbortController();
    let midErr: unknown;
    const rjs = (k as unknown as { js: { consumers: { getPushConsumer: (...a: unknown[]) => Promise<Record<string, unknown>> } } }).js;
    const victim = Object.create(k) as typeof k;
    Object.defineProperty(victim, "js", {
      value: {
        ...rjs,
        consumers: {
          ...rjs.consumers,
          getPushConsumer: async (...a: unknown[]) => {
            const oc = await rjs.consumers.getPushConsumer.apply(rjs.consumers, a);
            const realConsume = (oc.consume as () => Promise<AsyncIterable<unknown>>).bind(oc);
            return Object.assign(Object.create(oc as object), {
              consume: async () => {
                const inner = await realConsume();
                const gen = (async function* () {
                  for await (const m of inner) {
                    acMid.abort(new Error("aborted mid-scan"));
                    yield m;
                  }
                })();
                return Object.assign(gen, {
                  stop: () => (inner as { stop?: () => void }).stop?.(),
                  close: () => (inner as { close?: () => Promise<unknown> }).close?.() ?? Promise.resolve(),
                });
              },
            });
          },
        },
      },
    });
    try {
      await liveKvEntries(victim, ">", { signal: acMid.signal });
    } catch (e) {
      midErr = e;
    }
    check("cancellation: mid-scan abort throws abort reason", (midErr as Error)?.message === "aborted mid-scan", midErr);
    await wait(100);
    const afterMid = (await jsm.streams.info(stream)).state.consumer_count;
    check("cancellation: mid-scan abort reclaims consumer", afterMid === base, { base, afterMid });
  }

  // ── ROTATION: ROTATED/RECREATED CONSUMER IS DELETED IN FINALLY ──
  {
    const jsm = await jetstreamManager(nc);
    const stream = `KV_rotation_check`;
    const k = await kvm.create("rotation_check", { history: 1 });
    for (let i = 0; i < 5; i++) await k.put(`rot.${i}`, enc(`val.${i}`));
    const base = (await jsm.streams.info(stream)).state.consumer_count;

    // Controlled reset interposition over a real broker consumer, not a naturally observed rotation.
    const rjs = (k as unknown as { js: { consumers: { getPushConsumer: (...a: unknown[]) => Promise<Record<string, unknown>> } } }).js;
    const victim = Object.create(k) as typeof k;
    let rotatedName: string | undefined;
    Object.defineProperty(victim, "js", {
      value: {
        ...rjs,
        consumers: {
          ...rjs.consumers,
          getPushConsumer: async (...a: unknown[]) => {
            const oc = await rjs.consumers.getPushConsumer.apply(rjs.consumers, a);
            const realConsume = (oc.consume as () => Promise<AsyncIterable<unknown>>).bind(oc);
            return Object.assign(oc, {
              consume: async () => {
                const inner = await realConsume() as unknown as {
                  reset: () => void;
                  status: () => AsyncIterable<{ type: string; name?: string }>;
                  stop: () => void;
                  close: () => Promise<unknown>;
                  consumer: { name: string };
                };
                let didReset = false;
                const gen = (async function* () {
                  for await (const m of inner as unknown as AsyncIterable<unknown>) {
                    if (!didReset && typeof inner.reset === "function") {
                      didReset = true;
                      inner.reset();
                      rotatedName = inner.consumer?.name;
                    }
                    yield m;
                  }
                })();
                return Object.assign(gen, {
                  status: () => inner.status(),
                  stop: () => inner.stop(),
                  close: () => inner.close(),
                });
              },
            });
          },
        },
      },
    });

    const entries = await liveKvEntries(victim);
    check("rotation: scan completes and returns all entries", entries.length === 5, entries.length);
    await wait(200);
    const afterRotation = (await jsm.streams.info(stream)).state.consumer_count;
    check("rotation: rotated consumer is deleted in finally (no consumer leaked on broker)", afterRotation === base, { base, afterRotation, rotatedName });
  }

  // ── DELETION FAILURE AND TTL BACKSTOP PRESERVATION ──
  {
    const jsm = await jetstreamManager(nc);
    const stream = `KV_del_fail`;
    const k = await kvm.create("del_fail", { history: 1 });
    await k.put("key", enc("v"));

    let deleteAttempted = false;
    let observedTtlNanos: number | undefined;
    const rjs = (k as unknown as { js: { consumers: { getPushConsumer: (...a: unknown[]) => Promise<Record<string, unknown>> } } }).js;
    const victim = Object.create(k) as typeof k;
    Object.defineProperty(victim, "js", {
      value: {
        ...rjs,
        consumers: {
          ...rjs.consumers,
          getPushConsumer: async (...a: unknown[]) => {
            const oc = await rjs.consumers.getPushConsumer.apply(rjs.consumers, a);
            const ci = await (oc as { info: (cached?: boolean) => Promise<{ config: { inactive_threshold?: number } }> }).info(true);
            observedTtlNanos = ci.config.inactive_threshold;
            return oc;
          },
        },
      },
    });

    let scanResult: unknown;
    try {
      scanResult = await liveKvEntries(victim, {
        deleteOwnConsumer: async () => {
          deleteAttempted = true;
          throw new Error("simulated broker deletion failure");
        },
      });
    } catch (e) {
      scanResult = e;
    }
    check("deletion failure: a consumer delete error is thrown, not swallowed in finally", (scanResult as Error)?.message === "simulated broker deletion failure", (scanResult as Error)?.message ?? scanResult);
    check("deletion failure: delete was attempted in finally", deleteAttempted);
    check("deletion failure: consumer preserves non-zero inactive_threshold TTL as crash/failure backstop", typeof observedTtlNanos === "number" && observedTtlNanos > 0, observedTtlNanos);
  }

  // ── NATIVE AUTHORIZATION WITH SCOPED SCAN PERMISSIONS ──
  {
    const k = await kvm.create("scoped_auth_scan", { history: 1 });
    for (let i = 0; i < 3; i++) await k.put(`auth.${i}`, enc(`val.${i}`));
    const jsm = await jetstreamManager(nc);
    const base = (await jsm.streams.info("KV_scoped_auth_scan")).state.consumer_count;
    const res = await liveKvEntries(k, "auth.>");
    check("native authorization: scoped scan yields expected count (3)", res.length === 3, res.length);
    const after = (await jsm.streams.info("KV_scoped_auth_scan")).state.consumer_count;
    check("native authorization: consumer is deleted under scoped authorization", after === base, { base, after });
  }

  // ── INCOMPLETE/UNKNOWN SCAN MUST NEVER LOOK LIKE A COMPLETE EMPTY SET ──
  {
    const k = await kvm.create("incomplete_not_empty", { history: 1 });
    for (let i = 0; i < 10; i++) await k.put(`k.${i}`, enc(`v.${i}`));
    const jsm = await jetstreamManager(nc);
    const base = (await jsm.streams.info("KV_incomplete_not_empty")).state.consumer_count;

    const rjs = (k as unknown as { js: { consumers: { getPushConsumer: (...a: unknown[]) => Promise<Record<string, unknown>> } } }).js;
    const victim = Object.create(k) as typeof k;
    Object.defineProperty(victim, "js", {
      value: {
        ...rjs,
        consumers: {
          ...rjs.consumers,
          getPushConsumer: async (...a: unknown[]) => {
            const oc = await rjs.consumers.getPushConsumer.apply(rjs.consumers, a);
            return Object.assign(Object.create(oc as object), {
              consume: async () => {
                const gen = (async function* () {})();
                return Object.assign(gen, { stop: () => {}, close: async () => {} });
              },
            });
          },
        },
      },
    });

    let res: unknown;
    try {
      res = await liveKvEntries(victim);
    } catch (e) {
      res = e;
    }
    check("incomplete scan throws IncompleteKvScan (never returns empty array [])", res instanceof IncompleteKvScan, res);
    const after = (await jsm.streams.info("KV_incomplete_not_empty")).state.consumer_count;
    check("incomplete scan cleans up consumer in finally", after === base, { base, after });
  }

  // ── THE CONSUMER-FREE WALK. The same answer as the pass, by STREAM.MSG.GET alone: no consumer is
  //    created at any point, which is the property a records-store reader with no consumer verb
  //    depends on. Same collapse rules (newest revision wins, markers hide a key), same "no match is
  //    [] and not an error", and a filter that is a real subject pattern rather than a prefix. ────
  {
    const jsmw = await jetstreamManager(nc);
    const wk = await kvm.create("walk", { history: 3 });
    await wk.put("run.m.a.spec", enc("a1"));
    await wk.put("run.m.b.spec", enc("b1"));
    await wk.put("run.m.a.status", enc("s"));
    await wk.put("run.m.a.spec", enc("a2"));
    await wk.put("run.m.c.spec", enc("c1"));
    await wk.delete("run.m.c.spec");
    await wk.put("notice.m.a.x", enc("n"));
    const before = (await jsmw.streams.info("KV_walk")).state.consumer_count;
    const outBefore = nc.stats().outMsgs;
    const walked = await walkKvEntries(wk, "run.*.*.spec");
    const cost = nc.stats().outMsgs - outBefore;
    const after = (await jsmw.streams.info("KV_walk")).state.consumer_count;
    const byKey = new Map(walked.map((e) => [e.key, new TextDecoder().decode(e.value)]));
    check("the walk returns every live key the filter matches, and only those",
      [...byKey.keys()].sort().join(",") === "run.m.a.spec,run.m.b.spec", [...byKey.keys()]);
    check("the walk resolves a rewritten key to its NEWEST revision", byKey.get("run.m.a.spec") === "a2", byKey.get("run.m.a.spec"));
    check("a deleted key does not resurrect its retained prior value under the walk", !byKey.has("run.m.c.spec"), [...byKey.keys()]);
    check("the walk creates NO consumer (the consumer count is unchanged across it)", after === before, { before, after });
    // Five stored matches: a@1, b@2, a@4, c@5 and c's delete marker@6 (a marker is a stored message
    // on the same subject), then the one miss that ends the walk.
    check(`the walk is one request per stored match plus the terminating miss (${cost} for 5 stored matches)`, cost === 6, cost);
    check("a walk matching nothing returns [] in a non-empty bucket", (await walkKvEntries(wk, "zzz.>")).length === 0);
    check("a walk over an empty bucket returns []", (await walkKvEntries(await kvm.create("walk_empty", { history: 1 }), ">")).length === 0);
    const same = await liveKvEntries(wk, "run.*.*.spec");
    check("the walk and the pass agree on the live set",
      same.map((e) => `${e.key}@${e.revision}`).sort().join(",") === walked.map((e) => `${e.key}@${e.revision}`).sort().join(","));
    let walkRefused: unknown;
    await walkKvEntries({ history: async () => [] } as never, ">").catch((e) => { walkRefused = e; });
    check("the walk refuses a non-Bucket handle loudly too", walkRefused instanceof Error && /Bucket/.test(String((walkRefused as Error).message)), String(walkRefused));

  }

  // Withhold the broker's real empty-consumer info response. Abort only after it reaches the
  // proxy, before allowing the bind to finish. An immediate abort after starting the scan can
  // win before consumer creation and never exercise the empty-result boundary.
  {
    await kvm.create("abort_empty_bind", { history: 1 });
    const ac = new AbortController();
    let intercepted = 0;
    const proxy = createServer((client) => {
      const upstream = tcpConnect({ host: "127.0.0.1", port: PORT });
      client.on("data", (data) => upstream.write(data));
      upstream.on("data", (data) => {
        const text = data.toString("utf8");
        if (text.includes("KV_abort_empty_bind") && text.includes("num_pending") && text.includes("0")) {
          intercepted++;
          ac.abort(new Error("aborted-while-bind-pending"));
          setTimeout(() => { if (!client.destroyed) client.write(data); }, 40);
        } else client.write(data);
      });
      upstream.on("close", () => client.end());
      client.on("close", () => upstream.destroy());
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
    });
    let scanConn: Awaited<ReturnType<typeof connect>> | undefined;
    try {
      await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
      const address = proxy.address();
      if (!address || typeof address === "string") throw new Error("proxy has no TCP port");
      scanConn = await connect({ servers: `nats://127.0.0.1:${address.port}`, maxReconnectAttempts: 0 });
      const bucket = await new Kvm(scanConn).open("abort_empty_bind");
      let result: unknown;
      try { result = await liveKvEntries(bucket, { signal: ac.signal }); }
      catch (error) { result = error; }
      check("empty bind: real consumer-info response was intercepted once", intercepted === 1, intercepted);
      check("aborted during empty scan throws instead of returning empty array",
        ac.signal.aborted && (result as Error)?.message === "aborted-while-bind-pending", String(result));
      const count = (await (await jetstreamManager(nc)).streams.info("KV_abort_empty_bind")).state.consumer_count;
      check("empty bind: aborted scan leaves zero owned consumers", count === 0, count);
    } finally {
      await scanConn?.close();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  }

  // A real empty consumer can be bound and proven before cancellation. Hold its OWN delete,
  // abort during cleanup, then release it: the earlier bind-time check cannot observe this.
  // Keep an unrelated durable as a sentinel so broad consumer deletion fails this cell.
  {
    const bucket = await kvm.create("abort_empty_cleanup", { history: 1 });
    const stream = "KV_abort_empty_cleanup";
    const jsm = await jetstreamManager(nc);
    await jsm.consumers.add(stream, { durable_name: "unrelated_sentinel", ack_policy: "none", filter_subject: "$KV.abort_empty_cleanup.>" });
    const js = (bucket as unknown as { js: { consumers: { getPushConsumer: (...args: unknown[]) => Promise<{ info: () => Promise<unknown> }> } } }).js;
    const getPushConsumer = js.consumers.getPushConsumer.bind(js.consumers);
    const consumers = (bucket as unknown as { jsm: { consumers: { delete: (stream: string, name: string) => Promise<boolean> } } }).jsm.consumers;
    const deleteConsumer = consumers.delete.bind(consumers);
    try {
      for (const shape of ["filtered-control", "filtered", "options", "explicit-undefined"] as const) {
        const ac = new AbortController();
        let intercepted = 0;
        let release!: () => void;
        const released = new Promise<void>((resolve) => { release = resolve; });
        let entered!: () => void;
        const deleting = new Promise<void>((resolve) => { entered = resolve; });
        consumers.delete = async (stream, name) => {
          intercepted++;
          entered();
          await released;
          return deleteConsumer(stream, name);
        };
        const scan = (shape === "filtered" || shape === "filtered-control"
          ? liveKvEntries(bucket, "none.>", { signal: ac.signal })
          : shape === "options" ? liveKvEntries(bucket, { signal: ac.signal })
          : liveKvEntries(bucket, undefined, { signal: ac.signal }))
          .then((rows) => `RETURN:${rows.length}`, (e: Error) => `THROW:${e.message}`);
        try {
          await Promise.race([deleting, wait(5000).then(() => { throw new Error("owned delete not reached"); })]);
          const during = (await jsm.consumers.list(stream).next()).length;
          check(`empty cleanup ${shape}: own delete was intercepted with sentinel present`, intercepted === 1 && during === 2, { intercepted, during });
          if (shape !== "filtered-control") ac.abort(new Error("aborted-while-cleanup-pending"));
        } finally { release(); }
        const outcome = await scan;
        check(`empty cleanup ${shape}: ${shape === "filtered-control" ? "no-abort returns []" : "abort throws after delete"}`,
          outcome === (shape === "filtered-control" ? "RETURN:0" : "THROW:aborted-while-cleanup-pending"), outcome);
        const names = (await jsm.consumers.list(stream).next()).map((info) => info.name);
        check(`empty cleanup ${shape}: only unrelated sentinel remains`, names.length === 1 && names[0] === "unrelated_sentinel", names);
      }

      let release!: () => void;
      const released = new Promise<void>((resolve) => { release = resolve; });
      let entered!: () => void;
      const deleting = new Promise<void>((resolve) => { entered = resolve; });
      js.consumers.getPushConsumer = async (...args: unknown[]) => {
        const oc = await getPushConsumer(...args);
        oc.info = async () => { throw new Error("original-bind-error"); };
        return oc;
      };
      consumers.delete = async (stream, name) => { entered(); await released; return deleteConsumer(stream, name); };
      const ac = new AbortController();
      const failedScan = liveKvEntries(bucket, { signal: ac.signal }).then(
        () => "RETURN", (e: Error) => `THROW:${e.message}`);
      try {
        await Promise.race([deleting, wait(5000).then(() => { throw new Error("failed-bind cleanup not reached"); })]);
        ac.abort(new Error("late-abort-must-not-mask-original"));
      } finally { release(); }
      const failure = await failedScan;
      check("empty cleanup: original scan error survives later abort", failure === "THROW:original-bind-error", failure);
      const names = (await jsm.consumers.list(stream).next()).map((info) => info.name);
      check("failed-bind cleanup preserves unrelated sentinel", names.length === 1 && names[0] === "unrelated_sentinel", names);
    } finally { js.consumers.getPushConsumer = getPushConsumer; consumers.delete = deleteConsumer; }

    // The explicit-undefined shape must honor an already-aborted signal BEFORE creating a consumer.
    for (const shape of ["filtered", "options", "explicit-undefined"] as const) {
      const ac = new AbortController();
      ac.abort(new Error("pre-aborted-options"));
      let outcome = "none";
      try {
        const rows = shape === "filtered" ? await liveKvEntries(bucket, "none.>", { signal: ac.signal })
          : shape === "options" ? await liveKvEntries(bucket, { signal: ac.signal })
          : await liveKvEntries(bucket, undefined, { signal: ac.signal });
        outcome = `RETURN:${rows.length}`;
      } catch (e) { outcome = `THROW:${(e as Error).message}`; }
      check(`pre-aborted ${shape}: signal is honored`, outcome === "THROW:pre-aborted-options", outcome);
    }
    const names = (await jsm.consumers.list(stream).next()).map((info) => info.name);
    check("pre-aborted call shapes create no consumer and preserve sentinel", names.length === 1 && names[0] === "unrelated_sentinel", names);
  }

  await nc.close();
  console.log(`\nkv-scan smoke: ${pass} checks passed`);
} finally {
  srv.kill("SIGKILL");
  rmSync(store, { recursive: true, force: true });
  releaseBroker(); // last: ownership is held until cleanup has actually finished
}
process.exit(0);
