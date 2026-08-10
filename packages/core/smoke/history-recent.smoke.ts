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
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
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


  // ── TRUNCATION GATES. These force the two clean-iterator-end shapes directly on the private
  //    helpers. There is no PUBLIC seam into the endpoint's JetStream client, but a smoke can reach
  //    the private connection, and that is enough: the consumer bind is real, so bind-time
  //    `num_pending` is live, and only the fetch iterator's ENDING is simulated - as a clean stop
  //    with no error, which is exactly what the pinned client does when a connection drops
  //    ("we don't propagate the error here", @nats-io/jetstream consumer.js).
  //
  //    Deleting the completion checks from endpoint.ts must turn these red. That is the property an
  //    output-only assertion could never have, because the discarded stream-head algorithm returned
  //    identical values for every fixture in this file.
  const epNc = (ep as unknown as { nc: import("@nats-io/transport-node").NatsConnection }).nc;
  const priv = ep as unknown as {
    lastMatchingSeq(js: unknown, stream: string, subject: string): Promise<number>;
    drainWindow(js: unknown, stream: string, subject: string, start: number, ceiling: number): Promise<unknown[]>;
  };
  const CHAT = `CHAT_${SPACE}`;
  const TALK = `cotal.${SPACE}.chat.*.*.talk`;

  /** The real JetStream client, with every consumer's `fetch` truncated to `cut` messages and then
   *  ended cleanly - the shape a dropped link produces. */
  const truncatingJs = (cut: number) => {
    const real = jetstream(epNc);
    return {
      ...real,
      consumers: {
        ...real.consumers,
        get: async (...args: unknown[]) => {
          const c = await (real.consumers.get as (...a: unknown[]) => Promise<Record<string, unknown>>).apply(real.consumers, args);
          const realFetch = (c.fetch as (o?: unknown) => Promise<AsyncIterable<unknown>>).bind(c);
          return Object.assign(Object.create(c as object), {
            fetch: async (o?: unknown) => {
              const inner = await realFetch(o);
              const gen = (async function* () {
                let n = 0;
                for await (const m of inner) { if (n++ >= cut) return; yield m; }
              })();
              return Object.assign(gen, { stop: () => (inner as { stop?: () => void }).stop?.() });
            },
          });
        },
      },
    };
  };

  // 1. Last probe: bind says a message is pending, the fetch yields none, iterator ends cleanly.
  //    Returning 0 here is what made streamHistory report a live channel as empty.
  let lastThrew: unknown;
  await priv.lastMatchingSeq(truncatingJs(0), CHAT, TALK).then(
    (v) => { lastThrew = `RETURNED ${v}`; },
    (e) => { lastThrew = e; },
  );
  check("Last probe: pending>0 with zero deliveries RAISES (never reports an empty channel)",
    lastThrew instanceof Error, String(lastThrew));

  // 2. Window drain: cut after 3 of the pending batch, ending cleanly. Returning those 3 is what
  //    made a cut-short read look like a convincing short page.
  let drainThrew: unknown;
  await priv.drainWindow(truncatingJs(3), CHAT, TALK, 1, 10_000).then(
    (r) => { drainThrew = `RETURNED ${(r as unknown[]).length} messages`; },
    (e) => { drainThrew = e; },
  );
  check("window drain: a partial batch ending cleanly RAISES (never a short page)",
    drainThrew instanceof Error, String(drainThrew));

  // ── CROSS THE DOOR. The two gates above call the private helpers directly, so they prove the
  //    helpers raise but say NOTHING about whether the public entry point propagates that. If
  //    `streamHistory`'s catch swallowed an incomplete read back into `[]`, both would stay green
  //    while the shipped behaviour was the exact bug this branch fixed: "could not read" rendering
  //    as "no history". That catch has already been wrong once here, so the door needs its own gate.
  //
  //    Shadow the private helper on the instance to raise, then call the PUBLIC `channelHistory`.
  for (const method of ["lastMatchingSeq", "drainWindow"] as const) {
    const shadowed = ep as unknown as Record<string, unknown>;
    const real = shadowed[method];
    shadowed[method] = async () => { throw new Error(`forced ${method} truncation`); };
    let doorThrew: unknown;
    await ep.channelHistory("talk", { limit: 10 }).then(
      (r) => { doorThrew = `RETURNED ${r.length} messages`; },
      (e) => { doorThrew = e; },
    );
    shadowed[method] = real;
    check(`channelHistory PROPAGATES a cut-short ${method} (never renders it as an empty channel)`,
      doorThrew instanceof Error && /forced/.test(String((doorThrew as Error).message)), String(doorThrew));
  }
  // ...and the door still works normally once the shadow is removed, so the check above cannot pass
  // by having broken the endpoint.
  check("channelHistory still reads normally after the door gate",
    (await ep.channelHistory("talk", { limit: 3 })).length === 3);

  // ── REQUEST-SHAPE GATE: count REQUESTS, not wall clock. An exact per-subject ceiling answers a
  //    buried channel for about what a near-tail one costs; the discarded stream-head walk widened
  //    repeatedly and cost visibly more. Wall clock cannot express that (it passes on loopback and
  //    flakes on a loaded runner), so this measures the endpoint's outbound message delta.
  const outFor = async (ch: string) => {
    const b = epNc.stats().outMsgs;
    await ep.channelHistory(ch, { limit: 5 });
    return epNc.stats().outMsgs - b;
  };
  await outFor("noisy"); // warm any lazily-built client state so the comparison is fair
  const nearTail = await outFor("noisy");
  const buried = await outFor("quiet");
  check(`a buried channel costs about what a near-tail one does (near ${nearTail}, buried ${buried})`,
    buried <= nearTail + 4, { nearTail, buried });

  // Consumer hygiene: every probe and window is reclaimed. Complements the above - that gate proves
  // the ceiling is exact, this one proves nothing is left behind.
  const jsmc = await jetstreamManager((await connect({ servers: SERVER })));
  const consumers = async () => (await jsmc.streams.info(CHAT)).state.consumer_count;
  const before = await consumers();
  await ep.channelHistory("quiet", { limit: 10 });
  await ep.channelHistory("never-used", { limit: 10 });
  await wait(300);
  const after = await consumers();
  check(`history reclaims every consumer it creates (before ${before}, after ${after})`, after <= before, { before, after });

  await ep.stop();
  console.log(`\nhistory-recent smoke: ${pass} checks passed`);
} finally {
  srv.kill("SIGKILL");
  rmSync(store, { recursive: true, force: true });
}
process.exit(0);
