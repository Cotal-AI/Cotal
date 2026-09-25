/**
 * Broker-backed cancellation and timeout guarantees for submitAndFollowGoal.
 * Tests:
 *  1. Native byte-gate held nc.flush PONG: gate holds outbound bytes, abort while pending,
 *     verify follower settles BEFORE releasing gate; after release submit counter stays 0.
 *  2. In-flight submit with actual pending broker request (no responder reply): abort follower
 *     without cooperatively resolving request; verify follower settles; close connection AFTER assertion.
 *     Seam note: Synthetic submit seam uses a real NATS request with a silent subscriber
 *     (no reply sent) to simulate an unresponded action request without spinning up a full Manager endpoint.
 *  3. Post-flush abort: abort immediately post-flush before submit(); verify submit counter stays 0.
 *
 * Run: pnpm exec tsx packages/core/smoke/goal-follow-cancellation.smoke.ts
 */
import { spawn } from "node:child_process";
import { createServer, connect as tcpConnect, type Socket } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { encodeUser, fmtCreds } from "@nats-io/jwt";
import { fromPublic, fromSeed } from "@nats-io/nkeys";
import {
  createSpaceAuth,
  isReachable,
  mintLifecycleUid,
  newIdentity,
  serverConfig,
  standaloneConnectOpts,
  EpEnvelopeError,
  type EpAttributedReply,
  type EpCaller,
} from "../src/index.js";
import { SMOKE_BROKER_TOKEN, emitSentinel, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { submitAndFollowGoal } from "../src/endpoint-invoke.js";

// Native FIFO TCP gate
class OrderedGate {
  held: Buffer[] = [];
  holding = false;
  ready = false;
  upstream?: Socket;
  onHeldData?: (chunk: Buffer) => void;
  constructor(public client: Socket) {}
  take(chunk: Buffer): void {
    if (!this.ready || this.holding) {
      this.held.push(chunk);
      this.onHeldData?.(chunk);
    } else {
      this.upstream?.write(chunk);
    }
  }
  release(): void {
    this.holding = false;
    if (this.ready && this.held.length) {
      this.upstream?.write(Buffer.concat(this.held.splice(0)));
    }
  }
}

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  console.log(`${cond ? "ok" : "FAIL"} ${name}${cond || extra === undefined ? "" : ` ${JSON.stringify(extra)}`}`);
  if (cond) pass++; else fail++;
};

const enc = new TextEncoder();
const space = `nbp${mintLifecycleUid().slice(0, 8)}`;
const endpoint = "manager";
const caller: EpCaller = { owner: "local", actor: "seat", uid: mintLifecycleUid() };

const auth = await createSpaceAuth(space);
const brokerPort = 21000 + Math.floor(Math.random() * 18000);
const gatePort = brokerPort + 1;
const dir = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}cancellation-`));
writeFileSync(
  join(dir, "server.conf"),
  serverConfig(auth, [auth], {
    host: "127.0.0.1",
    port: brokerPort,
    storeDir: join(dir, "js"),
    transport: { kind: "plaintext" },
  })
);
const broker = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, dir);
const exited = new Promise<void>((resolve) => broker.once("exit", () => resolve()));

const gates: OrderedGate[] = [];
const gateServer = createServer((client) => {
  const row = new OrderedGate(client);
  gates.push(row);
  const upstream = tcpConnect(brokerPort, "127.0.0.1");
  row.upstream = upstream;
  upstream.on("connect", () => {
    row.ready = true;
    if (!row.holding && row.held.length) {
      upstream.write(Buffer.concat(row.held.splice(0)));
    }
  });
  client.on("data", (chunk) => row.take(chunk));
  upstream.on("data", (chunk) => client.write(chunk));
  const stop = () => { client.destroy(); upstream.destroy(); };
  client.on("error", stop); upstream.on("error", stop);
  client.on("close", () => upstream.destroy()); upstream.on("close", () => client.destroy());
});
await new Promise<void>((resolve) => gateServer.listen(gatePort, "127.0.0.1", resolve));

const followerIdentity = newIdentity();
const followerJwt = await encodeUser(
  "probe-follower",
  fromPublic(followerIdentity.id),
  fromPublic(auth.account.pub),
  {
    pub: { allow: [">"] },
    sub: { allow: [">"] },
  },
  { signer: fromSeed(enc.encode(auth.account.signingSeed)) }
);
const followerCreds = new TextDecoder().decode(fmtCreds(followerJwt, fromSeed(enc.encode(followerIdentity.seed))));

const conns: NatsConnection[] = [];
const trackedTimers: NodeJS.Timeout[] = [];

async function main() {
  const servers = `nats://127.0.0.1:${brokerPort}`;
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    up = await isReachable(servers);
    if (!up) await new Promise((r) => setTimeout(r, 100));
  }
  check("disposable broker reachable", up);

  // =========================================================================
  // CASE 1: Native byte-gate holds nc.flush() PONG -> abort while pending
  // =========================================================================
  {
    const follower = await connect({
      servers: `nats://127.0.0.1:${gatePort}`,
      ...standaloneConnectOpts({ creds: followerCreds, tls: false }),
      maxReconnectAttempts: 0,
      timeout: 4000,
    });
    conns.push(follower);
    await follower.flush();

    for (const g of gates) g.holding = true;

    let submitsCalled1 = 0;
    const controller1 = new AbortController();

    let heldPingSeen = false;
    for (const g of gates) {
      g.onHeldData = (chunk) => {
        if (chunk.toString("utf8").includes("PING")) heldPingSeen = true;
      };
    }

    const followP1 = submitAndFollowGoal(
      follower,
      space,
      endpoint,
      caller,
      5000,
      async () => {
        submitsCalled1++;
        return {
          reply: { ok: true, data: { goalId: "g-case1" } },
          responder: { endpoint, instanceId: "inst-1", epoch: 1 },
        } as EpAttributedReply;
      },
      { signal: controller1.signal }
    );

    // Wait until PING is queued in the gate (or timeout)
    await new Promise<void>((resolve) => {
      const poll = setInterval(() => {
        if (heldPingSeen || gates.some((g) => Buffer.concat(g.held).includes("PING"))) {
          clearInterval(poll);
          resolve();
        }
      }, 5);
      trackedTimers.push(poll);
      const timer = setTimeout(() => { clearInterval(poll); resolve(); }, 60);
      trackedTimers.push(timer);
    });

    controller1.abort();

    const timeoutWindow = 400;
    const raceResult1 = await Promise.race([
      followP1.then(
        (res) => ({ settled: true as const, kind: "resolved" as const, res }),
        (err) => ({ settled: true as const, kind: "rejected" as const, err })
      ),
      new Promise<{ settled: false }>((r) => {
        const timer = setTimeout(() => r({ settled: false }), timeoutWindow);
        trackedTimers.push(timer);
      }),
    ]);

    const settledBeforeRelease = raceResult1.settled === true;
    check(
      "aborted follower settles before gate release during held flush",
      settledBeforeRelease,
      { raceResult1 }
    );

    // Release gate to flush queued bytes to broker
    for (const g of gates) g.release();

    // Small delay to ensure no delayed submit runs
    await new Promise((r) => setTimeout(r, 100));

    check(
      "submit counter stays 0 after gate release",
      submitsCalled1 === 0,
      { submitsCalled1 }
    );
  }

  // =========================================================================
  // CASE 2: In-flight submit with real broker request (no responder reply)
  // Synthetic submit seam: real NATS request on subject with silent subscriber
  // (no reply sent) to simulate an unresponded action request without spinning
  // up a full Manager endpoint.
  // =========================================================================
  {
    const follower = await connect({
      servers: `nats://127.0.0.1:${brokerPort}`,
      ...standaloneConnectOpts({ creds: followerCreds, tls: false }),
      maxReconnectAttempts: 0,
      timeout: 4000,
    });
    conns.push(follower);

    const controller2 = new AbortController();
    let submitStarted = false;

    const silentSubject = `${space}.probe.silent`;
    // Create silent subscription so NATS broker does not return immediate 503 NoResponders
    follower.subscribe(silentSubject);

    const followP2 = submitAndFollowGoal(
      follower,
      space,
      endpoint,
      caller,
      5000,
      async () => {
        submitStarted = true;
        // Real NATS broker request with silent responder; do NOT cooperatively resolve!
        const rawReqP = follower.request(silentSubject, enc.encode("{}"), { timeout: 10_000 });
        await rawReqP;
        return {
          reply: { ok: true, data: { goalId: "g-case2" } },
          responder: { endpoint, instanceId: "inst-2", epoch: 1 },
        } as EpAttributedReply;
      },
      { signal: controller2.signal }
    );

    await new Promise<void>((resolve) => {
      const poll = setInterval(() => { if (submitStarted) { clearInterval(poll); resolve(); } }, 5);
      trackedTimers.push(poll);
      const timer = setTimeout(() => { clearInterval(poll); resolve(); }, 100);
      trackedTimers.push(timer);
    });

    controller2.abort();

    const timeoutWindow = 400;
    const raceResult2 = await Promise.race([
      followP2.then(
        (res) => ({ settled: true as const, kind: "resolved" as const, res }),
        (err) => ({ settled: true as const, kind: "rejected" as const, err })
      ),
      new Promise<{ settled: false }>((r) => {
        const timer = setTimeout(() => r({ settled: false }), timeoutWindow);
        trackedTimers.push(timer);
      }),
    ]);

    check(
      "aborted follower settles during pending unresponded broker submit",
      raceResult2.settled === true,
      { raceResult2 }
    );
    // Connection closed in finally AFTER this assertion
  }

  // =========================================================================
  // CASE 3: Post-flush abort must submit 0
  // =========================================================================
  {
    const follower = await connect({
      servers: `nats://127.0.0.1:${brokerPort}`,
      ...standaloneConnectOpts({ creds: followerCreds, tls: false }),
      maxReconnectAttempts: 0,
      timeout: 4000,
    });
    conns.push(follower);

    let submitsCalled3 = 0;
    const controller3 = new AbortController();

    const originalFlush = follower.flush.bind(follower);
    follower.flush = async () => {
      await originalFlush();
      controller3.abort();
    };

    try {
      await submitAndFollowGoal(
        follower,
        space,
        endpoint,
        caller,
        5000,
        async () => {
          submitsCalled3++;
          return {
            reply: { ok: true, data: { goalId: "g-case3" } },
            responder: { endpoint, instanceId: "inst-3", epoch: 1 },
          } as EpAttributedReply;
        },
        { signal: controller3.signal }
      );
    } catch {
      // Expected EpEnvelopeError on cancellation
    }

    check(
      "post-flush abort prevents goal submission (0 submits)",
      submitsCalled3 === 0,
      { submitsCalled3 }
    );
  }
}

try {
  await main();
} catch (e) {
  check("goal follow cancellation completed", false, e instanceof Error ? e.message : String(e));
} finally {
  for (const t of trackedTimers) clearTimeout(t);
  for (const nc of conns) await nc.close().catch(() => {});
  for (const g of gates) { g.client.destroy(); g.upstream?.destroy(); }
  await new Promise<void>((resolve) => gateServer.close(() => resolve()));
  if (broker.exitCode === null) broker.kill("SIGTERM");
  await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
  if (broker.exitCode === null) broker.kill("SIGKILL");
  await exited;
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
}

console.log(`goal-follow-cancellation smoke: ${pass} passed, ${fail} failed`);
emitSentinel({ passed: pass, failed: fail, cells: 5 });
process.exit(fail === 0 ? 0 : 1);
