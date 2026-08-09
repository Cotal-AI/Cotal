/**
 * `channelHistory` / `dmHistory` must return the MOST RECENT messages.
 *
 * They used to return the oldest. `js.consumers.get(stream, {...})` builds an ordered consumer that
 * defaults to `opt_start_seq: 1`, so capping the fetch at `limit` took the first N messages ever
 * sent, while the API is documented as "recent" and every caller renders it as the latest. On any
 * channel busier than one page, the dashboard and the agent history tools showed the beginning of
 * the conversation.
 *
 * Also asserted here: reading one page must not cost the whole backlog in transfer, since that is
 * the other half of why history was slow on a remote mesh.
 *
 * Needs nats-server on PATH. Run: pnpm smoke:history-recent
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import { CotalEndpoint, isReachable, newIdentity, setupSpaceStreams } from "../src/index.js";

const PORT = 14772;
const SERVER = `nats://127.0.0.1:${PORT}`;
const SPACE = "hist";
const store = mkdtempSync(join(tmpdir(), "cotal-hist-"));
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

  await setupSpaceStreams({ servers: SERVER, space: SPACE });

  const id = newIdentity();
  const ep = new CotalEndpoint({
    space: SPACE, servers: SERVER, channels: ["talk", "other"], consume: false,
    registerPresence: false, card: { id: id.id, name: "hist", kind: "endpoint" },
  });
  ep.on("error", () => {});
  await ep.start();

  // 60 messages on the channel under test, INTERLEAVED with another channel so the stream sequences
  // for "talk" are non-contiguous — the case where a start sequence cannot be computed arithmetically.
  const TOTAL = 60;
  for (let i = 0; i < TOTAL; i++) {
    await ep.multicast(`talk-${i}`, { channel: "talk" });
    if (i % 3 === 0) await ep.multicast(`other-${i}`, { channel: "other" });
  }
  await wait(300);

  const text = (m: { parts?: { kind: string; text?: string }[] }) =>
    m.parts?.map((p) => (p.kind === "text" ? p.text : "")).join("") ?? "";

  const all = await ep.channelHistory("talk", { limit: 500 });
  check(`reads the whole channel back (${all.length} of ${TOTAL})`, all.length === TOTAL, all.length);
  check("full read is oldest-first", text(all[0]!) === "talk-0" && text(all[all.length - 1]!) === `talk-${TOTAL - 1}`,
    [text(all[0]!), text(all[all.length - 1]!)]);

  // THE REGRESSION GATE.
  const ten = await ep.channelHistory("talk", { limit: 10 });
  const tenText = ten.map(text);
  const newestTen = Array.from({ length: 10 }, (_, i) => `talk-${TOTAL - 10 + i}`);
  const oldestTen = Array.from({ length: 10 }, (_, i) => `talk-${i}`);
  check("limit=10 returns 10", ten.length === 10, ten.length);
  check("limit=10 returns the NEWEST ten", JSON.stringify(tenText) === JSON.stringify(newestTen), tenText);
  check("limit=10 does NOT return the oldest ten (the bug)", JSON.stringify(tenText) !== JSON.stringify(oldestTen), tenText);
  check("the page is oldest-first within itself", text(ten[0]!) === `talk-${TOTAL - 10}`, tenText[0]);

  // Other page sizes, including ones that cross the widening threshold.
  for (const n of [1, 3, 25, 59]) {
    const page = await ep.channelHistory("talk", { limit: n });
    const want = Array.from({ length: n }, (_, i) => `talk-${TOTAL - n + i}`);
    check(`limit=${n} returns the newest ${n}`, JSON.stringify(page.map(text)) === JSON.stringify(want), page.map(text));
  }

  // A limit larger than the backlog returns everything, and does not pad or throw.
  const over = await ep.channelHistory("talk", { limit: 1000 });
  check("limit beyond the backlog returns the whole channel", over.length === TOTAL, over.length);

  // The interleaved channel is unaffected by the other channel's traffic.
  const otherPage = await ep.channelHistory("other", { limit: 5 });
  check("a different channel pages independently", otherPage.length === 5 && text(otherPage[4]!).startsWith("other-"), otherPage.map(text));

  // An empty channel is empty, not an error.
  check("an unused channel returns []", (await ep.channelHistory("never-used", { limit: 10 })).length === 0);

  // ── THE FAR-GAP CASE: a QUIET channel buried under a busy one. Its newest message sits far below
  //    the stream's last sequence, which is the shape that used to make every window near the stream
  //    head empty and walk the search back to the beginning. With an exact per-subject ceiling the
  //    page must come straight back. ────────────────────────────────────────────────────────────────
  await ep.multicast("quiet-1", { channel: "quiet" });
  await ep.multicast("quiet-2", { channel: "quiet" });
  for (let i = 0; i < 400; i++) await ep.multicast(`filler-${i}`, { channel: "noisy" });
  await wait(300);
  const quiet = await ep.channelHistory("quiet", { limit: 10 });
  check("far gap: a quiet channel buried under 400 filler messages still returns its own newest",
    quiet.length === 2 && text(quiet[0]!) === "quiet-1" && text(quiet[1]!) === "quiet-2", quiet.map(text));
  const noisyPage = await ep.channelHistory("noisy", { limit: 5 });
  check("far gap: the busy channel still pages to its newest 5",
    noisyPage.length === 5 && text(noisyPage[4]!) === "filler-399", noisyPage.map(text));
  // A channel that was configured but never used must cost one probe and stop, not a search.
  check("far gap: an unused channel in a busy stream returns [] without a search",
    (await ep.channelHistory("never-used", { limit: 10 })).length === 0);


  // ── REQUEST-SHAPE GATES. Everything above checks VALUES, and the discarded stream-head algorithm
  //    returned the same values for these fixtures — so those assertions could not tell the two
  //    apart. These two can: they fail against the old implementation, which widened from the
  //    stream head and left every consumer it created behind.

  const jsmc = await jetstreamManager((await connect({ servers: SERVER })));
  const chatStreamName = `CHAT_${SPACE}`;
  const consumers = async () => (await jsmc.streams.info(chatStreamName)).state.consumer_count;

  // 1. CONSUMER HYGIENE. Every probe and every window must be reclaimed. The old code created a
  //    consumer per widening attempt and deleted none, so a single far-gap read left nine behind.
  const before = await consumers();
  await ep.channelHistory("quiet", { limit: 10 });   // buried channel: exercises the probe + a window
  await ep.channelHistory("noisy", { limit: 5 });
  await ep.channelHistory("never-used", { limit: 10 }); // empty: probe only
  await wait(300);
  const after = await consumers();
  check(`history reclaims every consumer it creates (before ${before}, after ${after})`, after <= before, { before, after });

  // 2. THE EXACT CEILING IS USED. An unused channel must cost ONE probe and stop. Under the old
  //    stream-head walk it cost a widening search over the whole stream before concluding nothing
  //    was there, so this bounds request count rather than just checking the empty result.
  const t0 = Date.now();
  const none = await ep.channelHistory("never-used", { limit: 10 });
  const elapsed = Date.now() - t0;
  check(`an unused channel is answered by the ceiling probe alone (${elapsed}ms, no search)`,
    none.length === 0 && elapsed < 1000, { elapsed });

  await ep.stop();
  console.log(`\nhistory-recent smoke: ${pass} checks passed`);
} finally {
  srv.kill("SIGKILL");
  rmSync(store, { recursive: true, force: true });
}
process.exit(0);
