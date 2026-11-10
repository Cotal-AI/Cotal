/** Terminal run status must survive a broker outage without advancing the released program. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, RequestError } from "@nats-io/transport-node";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { createEndpointStreams, isReachable, openRecordsBucket, readRunRecord, replayRunJournal } from "@cotal-ai/core";
import { SimHandler } from "@cotal-ai/lang";
import { freePort, killAndAwaitExit, SMOKE_BROKER_TOKEN, teardownOnSignal, withDeadline } from "@cotal-ai/smoke-kit";
import { startRun } from "../dist/index.js";

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(ready: () => boolean | Promise<boolean>, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await ready())) {
    assert.ok(Date.now() < deadline, `${what} timed out`);
    await wait(50);
  }
}
const port = await freePort();
const servers = `nats://127.0.0.1:${port}`;
const store = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}run-status-recovery-`));
const space = "statusrecovery";
const endpoint = "manager";
let broker!: ChildProcess;
let releaseBroker: (() => void) | undefined;
const coreConfig = join(store, "core.conf");
writeFileSync(coreConfig, `port: ${port}\nhost: 127.0.0.1\n`);
async function boot(jetstreamEnabled = true): Promise<void> {
  broker = spawn("nats-server", jetstreamEnabled
    ? ["-js", "-sd", store, "-p", String(port), "-a", "127.0.0.1"]
    : ["-c", coreConfig], { stdio: "ignore" });
  releaseBroker = teardownOnSignal(broker, store);
  await until(async () => {
    assert.equal(broker.exitCode, null, "owned broker must survive startup");
    return await isReachable(servers);
  }, 10_000, "owned broker startup");
}
await boot();
const nc = await connect({ servers, maxReconnectAttempts: -1, reconnectTimeWait: 100, pingInterval: 500, maxPingOut: 1 });
const js = jetstream(nc, { timeout: 500 });
const jsm = await jetstreamManager(nc, { timeout: 500 });
await createEndpointStreams(jsm, new Kvm(nc), space);
const kv = await openRecordsBucket(nc, space);
let noResponderReads = 0;
const isWrappedNoResponder = (error: unknown): boolean => error instanceof Error
  && error.cause instanceof RequestError && error.cause.isNoResponders();
// Observe real transport errors without replacing any request or manufacturing failures.
const observedKv = new Proxy(kv, {
  get(target, property) {
    if (property === "get") return async (...args: Parameters<typeof kv.get>) => {
      try { return await target.get(...args); }
      catch (error) {
        if (isWrappedNoResponder(error)) noResponderReads += 1;
        throw error;
      }
    };
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
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
    space, endpoint, kv: observedKv, runId: "outage", source: 'await sleep("1s", { name: "first" }); await sleep("1s", { name: "second" });',
    lease: { holder: "m1", epoch: 1, fencingToken: 1, takeoverId: "t1" }, handler: new Outage(),
    statusConnection: nc,
  };
  let settled = false;
  const driven = startRun(js, jsm, request).finally(() => { settled = true; });
  await until(() => errors.some((line) => line.includes('"released" status write did not land')),
    30_000, "released status failure during outage");
  assert.equal(effects, 1, "the released run performs no later effect");
  await boot(false);
  await nc.reconnect();
  await until(async () => {
    try { await nc.flush(); return true; }
    catch { return false; }
  }, 10_000, "core-only broker reconnect");
  await assert.rejects(jsm.streams.info("unavailable"), isWrappedNoResponder,
    "management requests must expose the native wrapped no-responder error");
  await assert.rejects(js.publish("unavailable", new Uint8Array(), { retries: 1 }), isWrappedNoResponder,
    "publishes must expose the native wrapped no-responder error");
  await until(() => settled || noResponderReads >= 2, 15_000, "recovery through no-responder reads");
  assert.equal(noResponderReads >= 2, true, "terminal repair must keep reading through the no-responder window");
  assert.equal(settled, false, "a core-only broker must not end terminal repair");
  assert.equal(nc.isClosed(), false);
  await killAndAwaitExit(broker, "SIGKILL");
  releaseBroker?.();
  await boot();
  const out = await withDeadline(driven, 15_000, "run status reconciliation after broker returns");
  assert.ok(out);
  assert.equal(out.status, "released");
  await nc.reconnect();
  await until(async () => {
    try { await nc.flush(); return true; }
    catch { return false; }
  }, 10_000, "driver reconnect after broker restart");
  const record = await readRunRecord(kv, endpoint, "outage");
  assert.equal(record?.status?.value.state, "released", "released status must land after the broker returns");
  assert.equal(record?.status?.value.epoch, 1, "status reconciliation must not activate a new attempt");
  const replay = await replayRunJournal(js, jsm, space, "outage", "inspect");
  assert.equal(replay.records.filter((row) => row.record.kind === "activation").length, 1);
  assert.equal(effects, 1);
  console.log("run-status-recovery: timeout and wrapped no-responder recovery recorded release, no new activation or later effect");
} finally {
  console.error = originalError;
  await nc.close();
  await killAndAwaitExit(broker!);
  releaseBroker?.();
}
