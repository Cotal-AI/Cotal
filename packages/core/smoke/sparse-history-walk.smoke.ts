/**
 * A SPARSE CHANNEL HISTORY READ MUST NOT WALK TO STREAM SEQUENCE 1.
 *
 * WHAT WAS MEASURED (throwaway loopback broker, ~1700 seq chat stream, 3 matches on the
 * sparse channel). Discriminator is TRAVERSAL, not the returned page — the unbounded walk
 * already returns the correct three messages.
 *
 *   BEFORE the floor (current main):
 *     sparse-end limit=100: 2 drains, minStart=1, seqSpanSum=1203, wall 24ms, returned the 3 msgs
 *     dense limit=10:       1 drain,  minStart near the head, seqSpanSum=64
 *   AFTER a first-matching-seq floor, probed only on a short drain:
 *     sparse-end limit=100: 1 drain,  minStart=404 (the first match), seqSpanSum=400
 *     dense unchanged:      1 drain,  minStart near the head
 *
 * So this is a COST tidy, not a correctness bug: the page was right, the walk was the
 * stream's retained set rather than the channel's span. Wall time on ~1700 seq was tens
 * of milliseconds; the issue's 3.3s is a larger stream / many channels. The load is
 * stated, not a gate. The named cell is minStart staying ABOVE 1 on a high-end sparse
 * channel whose first match is not seq 1.
 *
 * Needs nats-server on PATH. Run: pnpm smoke:sparse-history-walk
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CotalEndpoint, isReachable, newIdentity, setupSpaceStreams } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

let cells = 0, failed = 0;
const ok = (name: string, cond: boolean, detail?: unknown): void => {
  cells++;
  if (cond) return;
  failed++;
  console.log(`  x FAIL  ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const textOf = (m: { parts: { kind: string; text?: string }[] }) =>
  m.parts.map((p) => (p.kind === "text" ? p.text ?? "" : "")).join("");

type Drain = { start: number; ceiling: number; delivered: number };
function instrument(ep: CotalEndpoint): Drain[] {
  const drains: Drain[] = [];
  const proto = Object.getPrototypeOf(ep);
  const orig = proto.drainWindow as (
    js: unknown, stream: string, subject: string, start: number, ceiling: number,
  ) => Promise<unknown[]>;
  proto.drainWindow = async function (
    this: CotalEndpoint, js: unknown, stream: string, subject: string, start: number, ceiling: number,
  ) {
    const page = await orig.call(this, js, stream, subject, start, ceiling) as unknown[];
    drains.push({ start, ceiling, delivered: page.length });
    return page;
  };
  return drains;
}

const PORT = await pickFreePort();
const SERVER = `nats://127.0.0.1:${PORT}`;
const SPACE = "sparsehist";
const store = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const broker = spawn("nats-server", ["-p", String(PORT), "-js", "-sd", store, "-a", "127.0.0.1"], { stdio: "ignore" });
const release = teardownOnSignal(broker, store);

try {
  let up = false;
  for (let i = 0; i < 80; i++) { if (await isReachable(SERVER)) { up = true; break; } await wait(100); }
  if (!up) throw new Error("nats-server did not start");
  await setupSpaceStreams({ servers: SERVER, space: SPACE });

  const writer = new CotalEndpoint({
    space: SPACE, servers: SERVER, channels: ["noise", "sparse-end", "dense"],
    consume: false, registerPresence: false, watchPresence: false,
    card: { id: newIdentity().id, name: "w", kind: "endpoint" },
  });
  writer.on("error", () => {});
  await writer.start();

  // Adversarial input: hundreds of OTHER-channel messages, then three on sparse-end at the
  // HIGH seq. A densely populated fixture would never exhibit the walk-to-1.
  for (let i = 0; i < 800; i++) await writer.multicast(`n${i}`, { channel: "noise" });
  await writer.multicast("end-1", { channel: "sparse-end" });
  await writer.multicast("end-2", { channel: "sparse-end" });
  await writer.multicast("end-3", { channel: "sparse-end" });
  for (let i = 0; i < 120; i++) await writer.multicast(`d${i}`, { channel: "dense" });
  await wait(200);

  const reader = new CotalEndpoint({
    space: SPACE, servers: SERVER, channels: [], consume: false,
    registerPresence: false, watchPresence: false,
    card: { id: newIdentity().id, name: "r", kind: "endpoint" },
  });
  reader.on("error", () => {});
  await reader.start();
  const drains = instrument(reader);

  drains.length = 0;
  const sparse = await reader.channelHistory("sparse-end", { limit: 100 });
  const sparseStarts = drains.map((d) => d.start);
  const minStart = Math.min(...sparseStarts);
  ok("1.1 CONTROL: the sparse channel really has only three matches (the page is not the bug)",
    sparse.map(textOf).join("|") === "end-1|end-2|end-3", sparse.map(textOf));
  ok("1.2 the walk does NOT start at stream sequence 1 (that is the unbounded drain)",
    minStart > 1, { minStart, drains });
  ok("1.3 the lowest start is at the HIGH end (the first sparse match), not a walk covering the noise prefix",
    minStart > 200, { minStart, drains });

  drains.length = 0;
  const dense = await reader.channelHistory("dense", { limit: 10 });
  const denseMin = Math.min(...drains.map((d) => d.start));
  ok("2.1 CONTROL: a dense page is still the newest N, not the oldest",
    textOf(dense[0]!) === "d110" && textOf(dense[dense.length - 1]!) === "d119", dense.map(textOf));
  ok("2.2 a dense page still does not walk to 1 (the floor probe must not tax a full drain)",
    denseMin > 1 && drains.length === 1, { denseMin, drains });

  await reader.stop().catch(() => {});
  await writer.stop().catch(() => {});
} finally {
  release();
  broker.kill("SIGKILL");
  rmSync(store, { recursive: true, force: true });
}

console.log(`\nsparse history walk smoke: ${cells - failed} passed, ${failed} failed`);
if (failed) process.exit(1);
