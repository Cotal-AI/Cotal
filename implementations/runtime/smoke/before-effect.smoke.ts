/** Kind-aware release through the shipped driver, on both recorded language versions. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  activateRun, createEndpointStreams, createRunSpec, isReachable, openRecordsBucket, readRunRecord, replayRunJournal,
} from "@cotal-ai/core";
import {
  ENGINE_LANGUAGE_VERSION, WALKER_LANGUAGE_VERSION, Cancelled, RootCancellation, RunReleased, SimHandler, resolvePins,
  Journal, run, resume,
  type EffectKind,
} from "@cotal-ai/lang";
import { startRun, driveRun, PauseToken, type DriveRequest } from "../dist/index.js";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { pickFreePort } from "./_free-port.js";

const source = `
await sleep("1s", { name: "rest" })
try {
  await spawn("ops", { name: "worker" })
} catch (e) {
  await sleep("2s", { name: "caught" })
} finally {
  await sleep("3s", { name: "cleanup" })
}
`;
class Counting extends SimHandler {
  readonly calls: string[] = [];
  override async sleep(req: Parameters<SimHandler["sleep"]>[0], ctx: Parameters<SimHandler["sleep"]>[1]) {
    this.calls.push(`sleep:${req.duration}`);
    return super.sleep(req, ctx);
  }
  override async spawn(req: Parameters<SimHandler["spawn"]>[0], ctx: Parameters<SimHandler["spawn"]>[1]) {
    this.calls.push("spawn");
    return super.spawn(req, ctx);
  }
}
const port = await pickFreePort();
const dir = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}before-effect-`));
const broker = spawn("nats-server", ["-js", "-sd", dir, "-p", String(port), "-a", "127.0.0.1"], { stdio: "ignore" });
teardownOnSignal(broker, dir);
let checks = 0;
let failures = 0;
const check = (value: unknown, message: string): void => {
  checks++;
  try { assert(value, message); }
  catch { failures++; console.error(`FAIL: ${message}`); }
};
let takeover = 0;
const lease = () => ({ holder: "host", epoch: ++takeover, fencingToken: takeover, takeoverId: `t${takeover}` });
try {
  const servers = `nats://127.0.0.1:${port}`;
  await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 60, delayMs: 100 });
  const nc = await connect({ servers: `nats://127.0.0.1:${port}` });
  try {
    const js = jetstream(nc);
    const jsm = await jetstreamManager(nc);
    const space = "beforeeffect";
    const endpoint = "manager";
    await createEndpointStreams(jsm, new Kvm(nc), space);
    const kv = await openRecordsBucket(nc, space);
    const fresh = async (version: string, request: DriveRequest) => {
      if (version === WALKER_LANGUAGE_VERSION) {
        await activateRun(js, jsm, { space, runId: request.runId, ...lease(), at: request.handler.now(), expect: "new" });
        await createRunSpec(kv, endpoint, request.runId, {
          pins: resolvePins({ runId: request.runId, ...(request.effectCeiling !== undefined ? { effectCeiling: request.effectCeiling } : {}) }, request.handler.now(), version),
          createdAt: request.handler.now(),
        });
        return driveRun(js, jsm, { ...request, lease: lease() });
      }
      return startRun(js, jsm, request);
    };
    for (const version of [WALKER_LANGUAGE_VERSION, ENGINE_LANGUAGE_VERSION]) {
      for (const refuse of [false, true]) {
        const runId = `v${version}-${refuse ? "release" : "control"}`;
        const handler = new Counting({});
        const seen: EffectKind[] = [];
        const request: DriveRequest = {
          space, endpoint, kv, runId, source, handler, lease: lease(),
          beforeEffect: (kind) => {
            seen.push(kind);
            return refuse && kind === "spawn" ? "budget before spawn" : undefined;
          },
        };
        const out = await fresh(version, request);
        const back = await replayRunJournal(js, jsm, space, runId, `read${++takeover}`);
        const steps = back.records.filter((r) => r.record.kind === "step");
        const pinned = (await readRunRecord(kv, endpoint, runId))!.spec.value.pins;
        check(pinned.languageVersion === version, `${runId}: actual engine version`);
        console.log(JSON.stringify({ runId, status: out.status, seen, calls: handler.calls, steps: steps.length }));
        if (refuse) {
          check(out.status === "released" && out.reason instanceof RunReleased && out.reason.reason === "budget before spawn", `${runId}: released with policy reason`);
          check(seen.join(",") === "sleep,spawn", `${runId}: actual live kinds`);
          check(handler.calls.join(",") === "sleep:1s", `${runId}: refused handler, catch and finally did not run`);
          check(steps.length === 2 && steps.every((r) => (r.record as { entry: { kind: string } }).entry.kind === "sleep"), `${runId}: only prefix pending and settled records`);
          const resumed = new Counting({});
          const resumedKinds: EffectKind[] = [];
          const next = await driveRun(js, jsm, {
            ...request, handler: resumed, lease: lease(),
            beforeEffect: (kind: EffectKind) => { resumedKinds.push(kind); return undefined; },
          });
          check(next.status === "completed", `${runId}: same-pin resume completes`);
          check(resumedKinds.join(",") === "spawn,sleep", `${runId}: replay never calls policy`);
          check(resumed.calls.join(",") === "spawn,sleep:3s", `${runId}: prefix never dispatched again`);
          check(JSON.stringify((await readRunRecord(kv, endpoint, runId))!.spec.value.pins) === JSON.stringify(pinned), `${runId}: pins unchanged`);
        } else {
          check(out.status === "completed", `${runId}: permit-all completes`);
          check(seen.join(",") === "sleep,spawn,sleep", `${runId}: permit-all sees each live effect once`);
          check(handler.calls.join(",") === "sleep:1s,spawn,sleep:3s", `${runId}: permit-all preserves execution`);
          let replayCalls = 0;
          const replay = await driveRun(js, jsm, {
            ...request, handler: new Counting({}), lease: lease(),
            beforeEffect: () => { replayCalls++; return "refuse all live work"; },
          });
          check(replay.status === "completed" && replayCalls === 0, `${runId}: full replay bypasses a refuse-all policy`);
        }
      }

      for (const kind of ["waitUntil", "conclave", "sleep"] as const) {
        const runId = `v${version}-${kind}`;
        const program = kind === "conclave"
          ? 'const a = await spawn("ops", { name: "a" }); await conclave([a], async () => 1, { name: "c" });'
          : kind === "waitUntil"
            ? 'await waitUntil(() => "ready", { name: "w", every: "1s", deadline: "1h", terminal: (v) => v === "ready" });'
            : 'await sleep("1s", { name: "s" });';
        const handler = new Counting({});
        const seen: EffectKind[] = [];
        const out = await fresh(version, {
          space, endpoint, kv, runId, source: program, handler, lease: lease(),
          // One admitted spawn fills the ceiling for conclave. The others must release before
          // the zero ceiling can fail the run, proving that a refusal does not count an effect.
          effectCeiling: kind === "conclave" ? 1 : 0,
          beforeEffect: async (next) => { seen.push(next); return next === kind ? "" : undefined; },
        });
        check(out.status === "released" && out.reason instanceof RunReleased && out.reason.reason === "", `${runId}: async empty reason beats effect ceiling`);
        check(seen.join(",") === (kind === "conclave" ? "spawn,conclave" : kind), `${runId}: specialized admission sees its own kind`);
        const back = await replayRunJournal(js, jsm, space, runId, `read${++takeover}`);
        check(back.records.filter((r) => r.record.kind === "step").every((r) => (r.record as { entry: { kind: string } }).entry.kind !== kind), `${runId}: refused kind has no durable entry`);
      }

      for (const stop of ["pause", "cancel"] as const) {
        const runId = `v${version}-${stop}-policy`;
        const pause = new PauseToken();
        const cancellation = new RootCancellation();
        const handler = new Counting({});
        const out = await fresh(version, {
          space, endpoint, kv, runId, source, handler, lease: lease(), pause, cancellation,
          beforeEffect: async () => {
            if (stop === "pause") pause.pause("stop during policy");
            else cancellation.cancel("stop during policy");
            return undefined;
          },
        });
        check(out.status === "released" && out.reason instanceof (stop === "pause" ? RunReleased : Cancelled), `${runId}: stop during policy remains a host release`);
        check(handler.calls.length === 0, `${runId}: stop during policy prevents dispatch`);
        const back = await replayRunJournal(js, jsm, space, runId, `read${++takeover}`);
        check(back.records.every((r) => r.record.kind !== "step"), `${runId}: stop during policy prevents pending append`);
      }

      const pause = new PauseToken();
      pause.pause("already paused");
      let policyCalls = 0;
      const out = await fresh(version, {
        space, endpoint, kv, runId: `v${version}-pause-first`, source, handler: new Counting({}), lease: lease(), pause,
        beforeEffect: () => { policyCalls++; return undefined; },
      });
      check(out.status === "released" && policyCalls === 0, `v${version}: pre-existing pause takes priority over policy`);

      let horizonCalls = 0;
      const expired = await fresh(version, {
        space, endpoint, kv, runId: `v${version}-horizon-first`, source, handler: new Counting({}), lease: lease(),
        workExpiry: 0,
        beforeEffect: () => { horizonCalls++; return "policy"; },
      });
      check(expired.status === "released" && expired.reason.message.includes("work horizon") && horizonCalls === 0, `v${version}: work horizon takes priority over policy`);

      const parallelSource = 'await parallel({ a: async () => await spawn("ops", { name: "a" }), b: async () => await sleep("1s", { name: "b" }) }, { name: "p" });';
      const concurrent = new Counting({});
      const runId = `v${version}-parallel`;
      const request: DriveRequest = {
        space, endpoint, kv, runId, source: parallelSource, handler: concurrent, lease: lease(),
        beforeEffect: async (kind) => kind === "spawn" ? "parallel budget" : undefined,
      };
      const released = await fresh(version, request);
      check(released.status === "released" && released.reason instanceof RunReleased, `${runId}: scope propagates release`);
      check(concurrent.calls.join(",") === "sleep:1s", `${runId}: sibling settles but refused spawn never dispatches`);
      const back = await replayRunJournal(js, jsm, space, runId, `read${++takeover}`);
      const entries = back.records.filter((r) => r.record.kind === "step").map((r) => (r.record as { entry: { kind: string; state: string } }).entry);
      check(entries.every((e) => e.kind !== "spawn") && entries.filter((e) => e.kind === "parallel").every((e) => e.state === "pending"), `${runId}: release neither settles scope nor appends refused work`);
      const resumed = new Counting({});
      const kinds: EffectKind[] = [];
      const completed = await driveRun(js, jsm, {
        ...request, handler: resumed, lease: lease(),
        beforeEffect: (kind) => { kinds.push(kind); return undefined; },
      });
      check(completed.status === "completed" && kinds.join(",") === "spawn" && resumed.calls.join(",") === "spawn", `${runId}: pending scope resumes only refused work`);
    }
  } finally {
    await nc.close();
  }
} finally {
  await killAndAwaitExit(broker);
}

const journal = new Journal({ run: "library-policy" });
const handler = new Counting({});
const pins = resolvePins({ runId: "library-policy" }, handler.now(), WALKER_LANGUAGE_VERSION);
let released: unknown;
try {
  await run(source, { runId: "library-policy", handler, journal, pins, beforeEffect: (kind) => kind === "spawn" ? "library budget" : undefined });
} catch (error) { released = error; }
check(released instanceof RunReleased && handler.calls.join(",") === "sleep:1s", "language run uses the same kind-aware boundary");
const seen: EffectKind[] = [];
const continued = await resume(source, journal, {
  runId: "library-policy", handler: new Counting({}), pins,
  beforeEffect: (kind) => { seen.push(kind); return undefined; },
});
check(continued.journal.entries().length === 3 && seen.join(",") === "spawn,sleep", "language resume skips recorded prefix policy");
console.log(`before-effect.smoke: ${checks - failures} passed, ${failures} failed`);
process.exitCode = failures === 0 ? 0 : 1;
