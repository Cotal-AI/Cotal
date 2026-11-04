/**
 * A TIMER WRITER'S stop() ENDS THE FETCH IT RACED, NOT THE POLL WINDOW (#3633).
 *
 * The pump records its in-flight fetch only after `consumer.fetch(...)` resolves, and `stop()`
 * closed only a recorded fetch. A stop() that landed while the pump was still issuing the fetch
 * found nothing to close and waited out the whole poll window (five seconds by default), which
 * the delivery daemon's close() then inherited. The pump now closes the batch as soon as the
 * fetch resolves when stop() has already run.
 *
 * The instrument is wall-clock time from stop() to its resolution, against a poll window the
 * cells set to three seconds so a regression reads as seconds, not noise. The control stops a
 * writer whose fetch is already recorded, which was fast before the fix and must stay fast.
 *
 * Needs nats-server on PATH.
 * Run: pnpm smoke:timer-writer-stop
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { createEndpointStreams, isReachable, startTimerWriter } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

let cells = 0, failed = 0;
const ok = (name: string, cond: boolean, detail?: unknown): void => {
  cells++;
  if (cond) { console.log(`  ✓ ${name}`); return; }
  failed++;
  console.log(`  x FAIL  ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SPACE = "twstop";
const POLL_MS = 3_000;
const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const broker = spawn("nats-server", ["-js", "-sd", join(dir, "js"), "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, dir);

try {
  let up = false;
  for (let i = 0; i < 100; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(100); }
  if (!up) throw new Error(`fixture broker never came up on ${SERVERS} - refusing to report on a server that never started`);
  const nc = await connect({ servers: SERVERS });
  await createEndpointStreams(await jetstreamManager(nc), new Kvm(nc), SPACE);

  // ---- 1. stop() in the same tick the writer started: the fetch is being issued, not recorded ----
  console.log("\n1. stop() racing the pump's first fetch");
  const raced = await startTimerWriter(nc, SPACE, { pollMs: POLL_MS });
  const t0 = Date.now();
  await raced.stop();
  const racedMs = Date.now() - t0;
  let racedDone = false;
  await Promise.race([raced.done.then(() => { racedDone = true; }), wait(200)]);
  ok(`1.1 stop() issued while the fetch was in flight resolves well inside the ${POLL_MS}ms poll window`, racedMs < POLL_MS / 2, { racedMs, POLL_MS });
  ok("1.2 and the pump's done settles with it", racedDone, { racedDone });

  // ---- 2. CONTROL: stop() after the fetch is recorded was already fast and stays fast ----
  console.log("\n2. CONTROL: stop() against a recorded fetch");
  const settled = await startTimerWriter(nc, SPACE, { pollMs: POLL_MS });
  await wait(500);
  const t1 = Date.now();
  await settled.stop();
  const settledMs = Date.now() - t1;
  ok(`2.1 stop() against a recorded fetch resolves well inside the poll window`, settledMs < POLL_MS / 2, { settledMs, POLL_MS });

  await nc.close();
} finally {
  releaseBroker();
  broker.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
}
console.log(failed === 0
  ? `timer-writer-stop smoke: ${cells} checks passed`
  : `timer-writer-stop smoke: ${failed} of ${cells} FAILED`);
process.exit(failed === 0 ? 0 : 1);
