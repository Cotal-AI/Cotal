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

  // ── Truncation. The guard under test is LOCAL: recognising that a pass ended without reaching its
  // terminal message, and refusing to return what arrived. Driving that by racing a real connection
  // close is inherently timing-dependent (a small bucket drains faster than any sleep can interleave,
  // and a big one would just move the race), and a test that silently passes when the race is lost
  // proves nothing. So the iterator is driven directly — the real broker above already proves the
  // wire shape; this proves the guard.
  const entry = (key: string, revision: number, delta: number, op: "PUT" | "DEL" = "PUT") =>
    ({ bucket: "stub", key, revision, delta, operation: op, value: enc("v"), created: new Date(0), length: 1,
       json: () => ({}), string: () => "v" }) as never;
  const stubKv = (entries: unknown[], values = entries.length) =>
    ({
      history: async () => (async function* () { for (const e of entries) yield e; })(),
      status: async () => ({ bucket: "stub", values }),
    }) as never;

  let cut: unknown;
  await liveKvEntries(stubKv([entry("a", 1, 5), entry("b", 2, 4)])).catch((e) => { cut = e; });
  check("a pass that never reaches the terminal message THROWS", cut instanceof IncompleteKvScan, String(cut));
  check("the throw names what was missed", cut instanceof IncompleteKvScan && /Refusing to return a partial view/.test(cut.message), String(cut));

  // The guard must not be always-on: a pass that DOES reach its terminal message returns normally.
  const complete = await liveKvEntries(stubKv([entry("a", 1, 1), entry("b", 2, 0)]));
  check("a pass that reaches the terminal message returns normally", complete.length === 2, complete.map((e) => e.key));

  // THE KNOWN GAP, asserted so it stays known. A pass that dies before its first message cannot be
  // told apart from an empty bucket through this client's API, so it reads as empty.
  //
  // An earlier version tried to close that by asking `kv.status()` and throwing when the bucket
  // reported entries. That was unsound in the other direction: `history()` ends on a CACHED
  // `num_pending === 0` and `status()` is a later round trip, so a first PUT landing in the gap
  // turned a legitimately-empty snapshot into a throw — a false failure on a healthy read, on
  // exactly the slow links that widen the window, and one round trip wasted on every empty scan.
  // Closing this properly needs the helper to bind its own consumer and read `num_pending` at bind
  // time. Until it does, this is the honest behaviour and it is pinned here.
  check("zero entries reads as empty, whatever the bucket reports (documented gap)",
    (await liveKvEntries(stubKv([], 7))).length === 0);
  check("zero entries from a genuinely empty bucket returns []", (await liveKvEntries(stubKv([], 0))).length === 0);
  check("no round trip is spent proving emptiness (status() is never consulted)", await (async () => {
    let statusCalls = 0;
    const counting = {
      history: async () => (async function* () { /* empty */ })(),
      status: async () => { statusCalls++; return { bucket: "stub", values: 7 }; },
    } as never;
    await liveKvEntries(counting);
    return statusCalls === 0;
  })());

  await nc.close();
  console.log(`\nkv-scan smoke: ${pass} checks passed`);
} finally {
  srv.kill("SIGKILL");
  rmSync(store, { recursive: true, force: true });
}
process.exit(0);
