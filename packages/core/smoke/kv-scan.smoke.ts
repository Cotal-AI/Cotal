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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { IncompleteKvScan, isReachable, liveKvEntries } from "../src/index.js";

const PORT = 14771;
const SERVER = `nats://127.0.0.1:${PORT}`;
const store = mkdtempSync(join(tmpdir(), "cotal-kvscan-"));
let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const srv = spawn("nats-server", ["-p", String(PORT), "-js", "-sd", store], { stdio: "ignore" });
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
        const realConsume = (oc.consume as () => Promise<AsyncIterable<unknown>>).bind(oc);
        // Real consumer, real bind-time num_pending; the ONLY thing altered is that the iterator
        // stops early and cleanly, exactly as the client does when the connection drops.
        return Object.assign(Object.create(oc as object), {
          consume: async () => {
            const inner = await realConsume();
            const gen = (async function* () {
              let n = 0;
              for await (const m of inner) { if (n++ >= cut) return; yield m; }
            })();
            // The helper stops the iterator in its finally, so the stand-in must carry `stop` too.
            return Object.assign(gen, { stop: () => (inner as { stop?: () => void }).stop?.() });
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

  await nc.close();
  console.log(`\nkv-scan smoke: ${pass} checks passed`);
} finally {
  srv.kill("SIGKILL");
  rmSync(store, { recursive: true, force: true });
}
process.exit(0);
