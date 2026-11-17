/**
 * A pi seat keeps a role request it took for as long as its turn runs (#5637). Two shipped
 * PiDrivers on real MeshAgents hold the same role on a real JetStream broker. The first one's turn
 * outlasts three ack waits, and the second must never be handed the same request.
 * Run: pnpm smoke:pi-role-hold
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import { CotalEndpoint, isReachable } from "@cotal-ai/core";
import { MeshAgent } from "@cotal-ai/connector-core";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, freePort, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { PiDriver, type CotalBatchDetails, type PiContextLike, type PiHost } from "../src/driver.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PORT = await freePort();
const servers = `nats://127.0.0.1:${PORT}`;
const space = "piroleheld";
const ROLE = "builder";
/** Short so three ack waits fit in seconds; a held delivery is renewed at half of it. */
const ACK_WAIT_MS = 3_000;
const TASK = "ROLE_TASK_5637";

const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const srv = spawn("nats-server", ["-js", "-p", String(PORT), "-sd", join(dir, "js")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);

let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
const waitFor = async (what: string, cond: () => boolean, ms = 10_000): Promise<void> => {
  for (let i = 0; i < ms / 100 && !cond(); i++) await sleep(100);
  if (!cond()) throw new Error(`timed out waiting for ${what}`);
};

/** One pi seat: the shipped driver over a real MeshAgent, wired as extension.ts wires it, with a
 *  fake Pi session that starts a turn for each dispatch and keeps it open until released. */
function seat(name: string) {
  const mesh = new MeshAgent({
    space, name, id: name.toLowerCase(), kind: "agent", role: ROLE, servers,
    subscribe: [], allowSubscribe: [], allowPublish: [], tls: false, ackWaitMs: ACK_WAIT_MS,
  });
  mesh.on("error", () => {});
  const driver = new PiDriver(mesh);
  const ctx: PiContextLike = { isIdle: () => !turnOpen, hasUI: false, ui: { notify: () => {} }, shutdown: () => {} };
  const received: string[] = [];
  let turnOpen = false;
  const host: PiHost = {
    sendMessage(message) {
      received.push(message.content);
      queueMicrotask(() => {
        const custom = { role: "custom", customType: message.customType, details: message.details satisfies CotalBatchDetails };
        turnOpen = true;
        driver.onAgentStart(ctx);
        driver.onMessageStart(custom);
        driver.onContext([custom]);
        driver.onProviderResponse(200);
      });
    },
  };
  mesh.on("incoming", () => driver.onIncoming());
  mesh.on("wake", () => driver.onWake());
  driver.bind(host);
  return {
    mesh, driver, received,
    start() { mesh.start(); driver.onSessionStart(ctx); },
    endTurn() { turnOpen = false; driver.onAgentEnd([{ role: "assistant", stopReason: "stop" }], ctx); },
  };
}

const ann = seat("Ann"), ben = seat("Ben");
const op = new CotalEndpoint({ space, servers, card: { name: "Op", kind: "agent", id: "op" }, channels: [] });
op.on("error", () => {});
let nc: Awaited<ReturnType<typeof connect>> | undefined;

try {
  await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 50, delayMs: 200 });
  await op.start();
  ann.start(); ben.start();
  await waitFor("both pi seats to join the roster", () => ["Ann", "Ben"].every((n) => op.getRoster().some((p) => p.card.name === n)));
  // A role consumer is bound by the first holder to start; let both finish binding before the send.
  await sleep(1_000);

  console.log("\n1. the holder whose turn is running keeps the role request");
  await op.anycast(ROLE, TASK);
  await waitFor("one pi seat to start a turn with the role request", () => [ann, ben].some((s) => s.received.some((c) => c.includes(TASK))));
  const first = ann.received.some((c) => c.includes(TASK)) ? ann : ben;
  const other = first === ann ? ben : ann;
  await sleep(ACK_WAIT_MS * 3);
  nc = await connect({ servers });
  const jsm = await jetstreamManager(nc);
  const held = await jsm.consumers.info(`TASK_${space}`, `svc_${ROLE}`);
  check("the other holder is never handed the request while the first one's turn runs",
    !other.received.some((c) => c.includes(TASK)), other.received);
  check("the role consumer redelivers nothing during a turn three ack waits long",
    held.num_redelivered === 0 && held.num_ack_pending === 1 && held.delivered.consumer_seq === 1,
    { redelivered: held.num_redelivered, ackPending: held.num_ack_pending, delivered: held.delivered.consumer_seq });

  console.log("\n2. the finished turn commits the request");
  first.endTurn();
  let done = await jsm.consumers.info(`TASK_${space}`, `svc_${ROLE}`);
  for (let i = 0; i < 50 && done.num_ack_pending !== 0; i++) { await sleep(100); done = await jsm.consumers.info(`TASK_${space}`, `svc_${ROLE}`); }
  const stream = await jsm.streams.info(`TASK_${space}`);
  check("the completed turn acknowledges the request and the work queue drops it",
    done.num_ack_pending === 0 && stream.state.messages === 0 && done.delivered.consumer_seq === 1,
    { ackPending: done.num_ack_pending, messages: stream.state.messages, delivered: done.delivered.consumer_seq });
  check("the other holder still never saw it", !other.received.some((c) => c.includes(TASK)), other.received);

  console.log(`\nPI ROLE HOLD SMOKE OK (${pass} passed, 0 failed)`);
} finally {
  await ann.driver.quit(); await ben.driver.quit();
  await ann.mesh.stop().catch(() => {}); await ben.mesh.stop().catch(() => {});
  await op.stop().catch(() => {});
  await nc?.close().catch(() => {});
  srv.kill("SIGKILL");
  await sleep(200);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
}
process.exit(0);
