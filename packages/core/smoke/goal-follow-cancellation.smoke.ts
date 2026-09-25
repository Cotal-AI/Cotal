/**
 * Broker-backed cancellation and timeout guarantees for submitAndFollowGoal.
 * Tests:
 *  1. Native byte-gate held nc.flush PONG: gate holds outbound bytes, abort while pending,
 *     verify follower settles with typed EpEnvelopeError (outcome: not-executed) BEFORE
 *     releasing gate; after release submit counter stays 0.
 *  2. In-flight submit with actual pending broker request: witness request arrival at silent
 *     subscriber, verify request is still pending (no reply), abort follower, and verify
 *     prompt settlement with typed EpEnvelopeError (outcome: unknown) before connection cleanup.
 *     Seam note: Synthetic submit seam uses a real NATS request with a silent subscriber
 *     (no reply sent) to simulate an unresponded action request without spinning up a full Manager endpoint.
 *  3. Post-flush abort: abort immediately post-flush before submit(); verify typed not-executed
 *     rejection and submit counter stays 0.
 *
 * Run: pnpm exec tsx packages/core/smoke/goal-follow-cancellation.smoke.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, connect as tcpConnect, type Socket, type Server, type AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
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
  epGoalProgressGrantRow,
  EpEnvelopeError,
  type EpAttributedReply,
  type EpCaller,
} from "../src/index.js";
import { SMOKE_BROKER_TOKEN, emitSentinel, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { submitAndFollowGoal } from "../src/endpoint-invoke.js";
import { pickFreePort } from "./_free-port.js";

// Native FIFO TCP gate
class OrderedGate {
  held: Buffer[] = [];
  holding = false;
  ready = false;
  upstream?: Socket;
  onHeldData?: () => void;
  constructor(public client: Socket) {}
  take(chunk: Buffer): void {
    if (!this.ready || this.holding) {
      this.held.push(chunk);
      this.onHeldData?.();
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
const silentSubject = `${space}.probe.silent`;

const conns: NatsConnection[] = [];
const gates: OrderedGate[] = [];
const trackedTimers: (NodeJS.Timeout | ReturnType<typeof setInterval>)[] = [];
let broker: ChildProcess | undefined;
let gateServer: Server | undefined;
let releaseBroker: (() => void) | undefined;
let dir = "";

try {
  const auth = await createSpaceAuth(space);
  const brokerPort = await pickFreePort();
  dir = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}cancel-probe-`));
  writeFileSync(
    join(dir, "server.conf"),
    serverConfig(auth, [auth], {
      host: "127.0.0.1",
      port: brokerPort,
      storeDir: join(dir, "js"),
      transport: { kind: "plaintext" },
    })
  );

  // Explicit broker child environment
  const brokerEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    SYSTEMROOT: process.env.SYSTEMROOT,
    TMPDIR: dir,
    COTAL_ROOT: dir,
  };
  broker = spawn("nats-server", ["-c", join(dir, "server.conf")], {
    stdio: "ignore",
    env: brokerEnv,
  });
  releaseBroker = teardownOnSignal(broker, dir);

  gateServer = createServer((client) => {
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

  // OS-assigned dynamic port for gate server
  await new Promise<void>((resolve, reject) => {
    gateServer!.once("error", reject);
    gateServer!.listen(0, "127.0.0.1", resolve);
  });
  const gatePort = (gateServer.address() as AddressInfo).port;

  // Scoped transport-only credentials: exact progress subject, connection reply inbox, and silent test subject
  const followerIdentity = newIdentity();
  const followerInbox = `_INBOX_${followerIdentity.id}.>`;
  const followerJwt = await encodeUser(
    "probe-follower",
    fromPublic(followerIdentity.id),
    fromPublic(auth.account.pub),
    {
      pub: { allow: [followerInbox, "_INBOX.>", silentSubject] },
      sub: { allow: [followerInbox, "_INBOX.>", epGoalProgressGrantRow(space, endpoint, caller), silentSubject] },
    },
    { signer: fromSeed(enc.encode(auth.account.signingSeed)) }
  );
  const followerCreds = new TextDecoder().decode(fmtCreds(followerJwt, fromSeed(enc.encode(followerIdentity.seed))));

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

    const followP1 = submitAndFollowGoal(
      follower,
      space,
      endpoint,
      caller,
      5000,
      async () => {
        submitsCalled1++;
        return {
          reply: {
            v: 1 as const,
            id: randomBytes(16).toString("base64url"),
            ok: true as const,
            data: { goalId: "g-case1" },
          },
          responder: { endpoint, instanceId: mintLifecycleUid(), epoch: 1 },
        };
      },
      { signal: controller1.signal }
    );

    // Held-byte barrier: verify PING is physically captured in gate buffer before aborting
    await new Promise<void>((resolve, reject) => {
      let poll: NodeJS.Timeout | undefined;
      const onHeld = () => {
        if (gates.some((g) => Buffer.concat(g.held).includes("PING"))) {
          if (poll) clearInterval(poll);
          resolve();
        }
      };
      for (const g of gates) g.onHeldData = onHeld;
      onHeld();
      poll = setInterval(onHeld, 5);
      trackedTimers.push(poll);
      const timer = setTimeout(() => {
        if (poll) clearInterval(poll);
        reject(new Error("timed out waiting for held PING in gate"));
      }, 500);
      trackedTimers.push(timer);
    });

    controller1.abort();

    // Check if follower settles BEFORE releasing gate (within 400ms) with typed not-executed outcome
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

    const isNotExecuted = raceResult1.settled === true
      && raceResult1.kind === "rejected"
      && raceResult1.err instanceof EpEnvelopeError
      && raceResult1.err.code === "unavailable"
      && raceResult1.err.outcome === "not-executed";

    check(
      "aborted follower settles before gate release with not-executed during held flush",
      isNotExecuted,
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
    let submitFinished = false;
    let silentReceived = false;

    // Silent subscriber receives request but sends no reply, keeping request pending on wire
    follower.subscribe(silentSubject, {
      callback: () => {
        silentReceived = true;
      },
    });
    await follower.flush();

    const followP2 = submitAndFollowGoal(
      follower,
      space,
      endpoint,
      caller,
      5000,
      async (signal) => {
        submitStarted = true;
        // Real NATS broker request on silent subject; do NOT cooperatively resolve!
        const rawReqP = follower.request(silentSubject, enc.encode("{}"), { timeout: 10_000 });
        await rawReqP;
        submitFinished = true;
        return {
          reply: {
            v: 1 as const,
            id: randomBytes(16).toString("base64url"),
            ok: true as const,
            data: { goalId: "g-case2" },
          },
          responder: { endpoint, instanceId: mintLifecycleUid(), epoch: 1 },
        };
      },
      { signal: controller2.signal }
    );

    // Barrier: wait until silent subscriber callback actually receives the request over NATS
    await new Promise<void>((resolve, reject) => {
      let poll: NodeJS.Timeout | undefined;
      const checkReceived = () => {
        if (silentReceived && submitStarted) {
          if (poll) clearInterval(poll);
          resolve();
        }
      };
      poll = setInterval(checkReceived, 5);
      trackedTimers.push(poll);
      const timer = setTimeout(() => {
        if (poll) clearInterval(poll);
        reject(new Error("timed out waiting for silent subscriber request receipt"));
      }, 1000);
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

    const isUnknown = raceResult2.settled === true
      && raceResult2.kind === "rejected"
      && raceResult2.err instanceof EpEnvelopeError
      && raceResult2.err.code === "unavailable"
      && raceResult2.err.outcome === "unknown";

    const stillPending = submitStarted && silentReceived && !submitFinished;

    check(
      "aborted follower settles with unknown outcome during pending broker submit",
      isUnknown && stillPending,
      { isUnknown, stillPending, submitStarted, silentReceived, submitFinished, raceResult2 }
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

    let error3: unknown;
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
            reply: {
              v: 1 as const,
              id: randomBytes(16).toString("base64url"),
              ok: true as const,
              data: { goalId: "g-case3" },
            },
            responder: { endpoint, instanceId: mintLifecycleUid(), epoch: 1 },
          };
        },
        { signal: controller3.signal }
      );
    } catch (err) {
      error3 = err;
    }

    const isNotExecuted = error3 instanceof EpEnvelopeError
      && error3.code === "unavailable"
      && error3.outcome === "not-executed";

    check(
      "post-flush abort prevents goal submission with typed not-executed error",
      isNotExecuted && submitsCalled3 === 0,
      { isNotExecuted, submitsCalled3, error3 }
    );
  }
} catch (e) {
  check("goal follow cancellation completed", false, e instanceof Error ? e.message : String(e));
} finally {
  for (const t of trackedTimers) {
    clearTimeout(t as NodeJS.Timeout);
    clearInterval(t as NodeJS.Timeout);
  }
  for (const nc of conns) await nc.close().catch(() => {});
  for (const g of gates) { g.client.destroy(); g.upstream?.destroy(); }
  if (gateServer) await new Promise<void>((resolve) => gateServer!.close(() => resolve())).catch(() => {});
  if (broker) await killAndAwaitExit(broker, "SIGTERM").catch(() => {});
  if (dir) rmSync(dir, { recursive: true, force: true });
  releaseBroker?.();
}

const totalCells = pass + fail;
console.log(`goal-follow-cancellation smoke: ${pass} passed, ${fail} failed (cells: ${totalCells})`);
emitSentinel({ passed: pass, failed: fail, cells: totalCells });
process.exit(fail === 0 && totalCells === 5 ? 0 : 1);
