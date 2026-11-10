/** Recovery controls on real run records: uncertainty, takeover, shutdown and permanent faults. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, RequestError, TimeoutError } from "@nats-io/transport-node";
import { jetstream, jetstreamManager, JetStreamApiError } from "@nats-io/jetstream";
import { Kvm, type KV } from "@nats-io/kv";
import { createEndpointStreams, isReachable, openRecordsBucket, readRunRecord, writeRunStatus, type RunStatusValue } from "@cotal-ai/core";
import { SimHandler } from "@cotal-ai/lang";
import { freePort, killAndAwaitExit, SMOKE_BROKER_TOKEN, teardownOnSignal, withDeadline } from "@cotal-ai/smoke-kit";
import { PauseToken, startRun } from "../src/run-driver.js";

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const port = await freePort();
const store = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}status-controls-`));
const broker = spawn("nats-server", ["-js", "-sd", store, "-p", String(port), "-a", "127.0.0.1"], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, store);
const servers = `nats://127.0.0.1:${port}`;
const startupDeadline = Date.now() + 10_000;
while (!(await isReachable(servers))) {
  assert.equal(broker.exitCode, null, "owned broker must survive startup");
  assert.ok(Date.now() < startupDeadline, "broker startup timed out");
  await wait(50);
}
const nc = await connect({ servers });
const jsm = await jetstreamManager(nc);
const js = jetstream(nc);
const space = "statuscontrols", endpoint = "manager";
await createEndpointStreams(jsm, new Kvm(nc), space);
const kv = await openRecordsBucket(nc, space);
try {
  for (const mode of ["late-ack", "successor", "closed", "permanent", "wrapped-permanent", "wrapped-other-request", "completed", "failed"] as const) {
    const pause = new PauseToken();
    let attempted!: () => void;
    const firstAttempt = new Promise<void>((resolve) => { attempted = resolve; });
    let terminalWrites = 0;
    let closed = false;
    const intercepted = new Proxy(kv, {
      get(target, property) {
        if (property === "update") return async (...args: Parameters<KV["update"]>) => {
          const value = JSON.parse(new TextDecoder().decode(args[1] as Uint8Array)) as RunStatusValue;
          if (value.state !== "running") {
            terminalWrites += 1;
            if (terminalWrites === 1) {
              if (mode === "late-ack") await target.update(...args);
              attempted();
              if (mode === "wrapped-permanent") throw new Error("jetstream is not enabled", {
                cause: new JetStreamApiError({ code: 503, err_code: 10039, description: "JetStream not enabled for account" }),
              });
              if (mode === "wrapped-other-request") throw new Error("jetstream is not enabled", {
                cause: new RequestError("permanent request refusal"),
              });
              throw mode === "permanent" ? new Error("permanent store refusal") : new TimeoutError();
            }
          }
          return await target.update(...args);
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    class Stops extends SimHandler {
      override async sleep(req: Parameters<SimHandler["sleep"]>[0], ctx: Parameters<SimHandler["sleep"]>[1]) {
        if (mode !== "completed" && mode !== "failed") pause.pause("operator pause");
        return await super.sleep(req, ctx);
      }
    }
    const source = mode === "failed" ? 'throw "program failed";'
      : 'await sleep("1s", {name:"first"}); await sleep("1s", {name:"second"});';
    const driven = startRun(js, jsm, {
      space, endpoint, kv: intercepted, runId: mode, source, handler: new Stops(), pause,
      lease: { holder: "m1", epoch: 1, fencingToken: 1, takeoverId: mode },
      statusConnection: { isClosed: () => closed },
    }).then((out) => out.status, (error: Error) => error.message);
    await withDeadline(firstAttempt, 10_000, `${mode} terminal write`);
    if (mode === "successor") {
      const current = (await readRunRecord(kv, endpoint, mode))!;
      await writeRunStatus(kv, endpoint, mode, { ...current.status!.value, holder: "m2", epoch: 2, fencingToken: 2 }, current.status!.revision);
    }
    if (mode === "closed") closed = true;
    const outcome = await withDeadline(driven, 5_000, `${mode} recovery`);
    const status = (await readRunRecord(kv, endpoint, mode))!.status!.value;
    if (mode === "successor") {
      assert.equal(status.holder, "m2");
      assert.equal(status.epoch, 2);
      assert.equal(terminalWrites, 1);
    } else if (mode === "closed" || mode === "permanent" || mode === "wrapped-permanent" || mode === "wrapped-other-request") {
      assert.equal(status.state, "running");
      assert.equal(terminalWrites, 1, "closed connections and permanent errors must stop recovery");
    } else {
      assert.equal(status.state, mode === "completed" ? "completed" : mode === "failed" ? "failed" : "released");
      assert.equal(terminalWrites, mode === "late-ack" ? 1 : 2);
      if (mode === "failed") assert.match(status.failure!.message, /program failed/);
    }
    assert.equal(outcome, mode === "completed" ? "completed" : mode === "failed" ? "program failed" : "released");
    console.log(`status recovery control passed: ${mode}`);
  }
} finally {
  await nc.close();
  await killAndAwaitExit(broker);
  releaseBroker();
}
