/** Terminal run status must survive a broker outage without advancing the released program. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { createEndpointStreams, isReachable, openRecordsBucket, readRunRecord, replayRunJournal } from "@cotal-ai/core";
import { SimHandler } from "@cotal-ai/lang";
import { freePort, killAndAwaitExit, SMOKE_BROKER_TOKEN, teardownOnSignal, withDeadline } from "@cotal-ai/smoke-kit";
import { startRun } from "../src/run-driver.js";

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const port = await freePort();
const servers = `nats://127.0.0.1:${port}`;
const store = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}run-status-recovery-`));
const space = "statusrecovery";
const endpoint = "manager";
let broker: ChildProcess;
let releaseBroker: (() => void) | undefined;
async function boot(): Promise<void> {
  broker = spawn("nats-server", ["-js", "-sd", store, "-p", String(port), "-a", "127.0.0.1"], { stdio: "ignore" });
  releaseBroker = teardownOnSignal(broker, store);
  await withDeadline((async () => {
    while (!(await isReachable(servers))) {
      if (broker.exitCode !== null) throw new Error("owned broker exited during startup");
      await wait(50);
    }
  })(), 10_000, "owned broker startup");
}
await boot();
const nc = await connect({ servers, maxReconnectAttempts: -1, reconnectTimeWait: 100, pingInterval: 500, maxPingOut: 1 });
const js = jetstream(nc, { timeout: 500 });
const jsm = await jetstreamManager(nc, { timeout: 500 });
await createEndpointStreams(jsm, new Kvm(nc), space);
const kv = await openRecordsBucket(nc, space);
const errors: string[] = [];
const originalError = console.error;
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); originalError(...args); };
let effects = 0;
try {
  class Outage extends SimHandler {
    override async sleep(req: Parameters<SimHandler["sleep"]>[0], ctx: Parameters<SimHandler["sleep"]>[1]) {
      effects += 1;
      await killAndAwaitExit(broker, "SIGKILL");
      releaseBroker?.();
      return await super.sleep(req, ctx);
    }
  }
  const request = {
    space, endpoint, kv, runId: "outage", source: 'await sleep("1s", { name: "first" }); await sleep("1s", { name: "second" });',
    lease: { holder: "m1", epoch: 1, fencingToken: 1, takeoverId: "t1" }, handler: new Outage(),
    statusConnection: nc,
  };
  const driven = startRun(js, jsm, request);
  await withDeadline((async () => {
    while (!errors.some((line) => line.includes('"released" status write did not land'))) await wait(50);
  })(), 30_000, "released status failure during outage");
  assert.equal(effects, 1, "the released run performs no later effect");
  await boot();
  const out = await withDeadline(driven, 15_000, "run status reconciliation after broker returns");
  assert.ok(out);
  assert.equal(out.status, "released");
  await nc.reconnect();
  await withDeadline((async () => {
    for (;;) {
      try { await nc.flush(); return; }
      catch { await wait(100); }
    }
  })(), 10_000, "driver reconnect after broker restart");
  const record = await readRunRecord(kv, endpoint, "outage");
  assert.equal(record?.status?.value.state, "released", "released status must land after the broker returns");
  assert.equal(record?.status?.value.epoch, 1, "status reconciliation must not activate a new attempt");
  const replay = await replayRunJournal(js, jsm, space, "outage", "inspect");
  assert.equal(replay.records.filter((row) => row.record.kind === "activation").length, 1);
  assert.equal(effects, 1);
  console.log("run-status-recovery: outage release recorded, no new activation or later effect");
} finally {
  console.error = originalError;
  await nc.close();
  await killAndAwaitExit(broker!);
  releaseBroker?.();
}
