/**
 * A HISTORY READ REFUSES A LIMIT IT CANNOT ANSWER, INSTEAD OF SEARCHING FOREVER.
 *
 * `streamHistory` widens a window until it holds a full page or reaches sequence 1. Both exits
 * compare against the caller's limit, and BOTH ARE UNREACHABLE when that limit is `NaN`:
 * `page.length >= NaN` is false forever, and `start === 1` compares against a `start` that is itself
 * `NaN`. The guard above them, `limit <= 0`, does not fire either, because every comparison against
 * `NaN` is false. So the read does not return everything, it never returns.
 *
 * MEASURED THROUGH THE DASHBOARD BEFORE THIS GUARD EXISTED (Cotal #699), on a real broker: one
 * `?limit=abc` GET never answered, and the ABANDONED request was still consuming 46% of a core
 * twenty seconds after its caller aborted, while the process kept serving every other route so
 * nothing announced it. `Infinity` reaches the same hole from the other end: it passes the guard,
 * `start` collapses to 1, and `slice(-Infinity)` returns the subject's whole retained set.
 *
 * WHY THIS LIVES IN CORE'S OWN SUITE. The dashboard refuses a malformed limit at its routes, so
 * nothing it sends can reach this guard, and `implementations/web` resolves core through `dist`
 * anyway, where a mutation of this source has no effect. A rule that protects every caller has to be
 * graded where it is written.
 *
 * Needs nats-server on PATH. Run: pnpm smoke:core-history-limit
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net, { type AddressInfo } from "node:net";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { CotalEndpoint, isReachable, newIdentity, setupSpaceStreams } from "../src/index.js";

let cells = 0, failed = 0;
const ok = (name: string, cond: boolean, detail?: unknown): void => {
  cells++;
  if (cond) return;
  failed++;
  console.log(`  x FAIL  ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = async (): Promise<number> => new Promise((res) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); });
});

/** EVERY CALL HERE IS BOUNDED, because the defect under test is a call that never returns. With the
 *  guard mutated away an unbounded read would kill the run on the harness timeout and report an
 *  unknown, instead of reddening the assertion that names the rule. `null` means "never returned",
 *  which is the finding rather than an error. */
const CEILING_MS = 20_000;
const settled = async <T>(work: Promise<T>): Promise<{ threw: string } | { value: T } | null> => {
  const r = await Promise.race([
    work.then((value) => ({ value })).catch((e: Error) => ({ threw: e.message })),
    wait(CEILING_MS).then(() => null),
  ]);
  return r as { threw: string } | { value: T } | null;
};

const PORT = await freePort();
const SERVER = `nats://127.0.0.1:${PORT}`;
const SPACE = "corehistlimit";
const store = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const broker = spawn("nats-server", ["-p", String(PORT), "-js", "-sd", store, "-a", "127.0.0.1"], { stdio: "ignore" });
const release = teardownOnSignal(broker, store);
let ep: CotalEndpoint | undefined;
try {
  let up = false;
  for (let i = 0; i < 80; i++) { if (await isReachable(SERVER)) { up = true; break; } await wait(150); }
  if (!up) throw new Error("nats-server did not start");
  await setupSpaceStreams({ servers: SERVER, space: SPACE });

  ep = new CotalEndpoint({ space: SPACE, servers: SERVER, channels: ["ch0"], consume: false,
    registerPresence: false, card: { id: newIdentity().id, name: "hist", kind: "endpoint" } });
  ep.on("error", () => {});
  await ep.start();
  for (let i = 0; i < 30; i++) await ep.multicast(`m${i}`, { channel: "ch0" });

  console.log("1. a limit that cannot be answered is refused, not searched for");
  const nan = await settled(ep.channelHistory("ch0", { limit: Number.NaN }));
  ok("1.1 a NaN limit REFUSES, naming what it received, rather than never returning",
    !!nan && "threw" in nan && nan.threw.includes("finite") && nan.threw.includes("NaN"),
    nan === null ? "never returned" : nan);
  const inf = await settled(ep.channelHistory("ch0", { limit: Number.POSITIVE_INFINITY }));
  ok("1.2 an Infinite limit refuses too, which is the other end of the same skipped guard",
    !!inf && "threw" in inf && inf.threw.includes("finite"),
    inf === null ? "never returned" : inf);
  ok("1.3 the DM read carries the same rule, since it is the same search underneath",
    await settled(ep.dmHistory({ limit: Number.NaN })).then((r) => !!r && "threw" in r && r.threw.includes("finite")));

  console.log("2. the shapes that already worked are untouched");
  const zero = await settled(ep.channelHistory("ch0", { limit: 0 }));
  ok("2.1 zero still means an EMPTY page, not a throw and not everything",
    !!zero && "value" in zero && zero.value.length === 0, zero);
  const neg = await settled(ep.channelHistory("ch0", { limit: -3 }));
  ok("2.2 a negative limit still means an empty page, its existing meaning",
    !!neg && "value" in neg && neg.value.length === 0, neg);
  // POSITIVE CONTROL: a guard that refuses the unanswerable must still answer the answerable.
  const seven = await settled(ep.channelHistory("ch0", { limit: 7 }));
  ok("2.3 control: a valid limit still reads its page, so 1.1 is a refusal and not a broken read",
    !!seven && "value" in seven && seven.value.length === 7, seven);
} finally {
  await ep?.stop().catch(() => {});
  release(); broker.kill("SIGKILL"); rmSync(store, { recursive: true, force: true });
}
console.log(failed === 0 ? `core history limit: ${cells} cells OK` : `core history limit: ${failed}/${cells} FAILED`);
process.exit(failed === 0 ? 0 : 1);
