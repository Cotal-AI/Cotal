/**
 * Broker-confirmed ordering for a goal followed on one connection and submitted on another.
 * The standing connection crosses a byte-ordered TCP gate. The publisher connects directly.
 * Run: pnpm smoke:goal-submit-order
 */
import { spawn } from "node:child_process";
import { createServer, connect as tcpConnect, type Socket, type AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { encodeUser, fmtCreds } from "@nats-io/jwt";
import { fromPublic, fromSeed } from "@nats-io/nkeys";
import {
  createSpaceAuth,
  epServePublishRows,
  epeSubject,
  goalProgressTopic,
  isReachable,
  mintCreds,
  mintLifecycleUid,
  newIdentity,
  serverConfig,
  standaloneConnectOpts,
  submitAndFollowGoal,
  type EpAttributedReply,
} from "../src/index.js";
import { SMOKE_BROKER_TOKEN, emitSentinel, teardownOnSignal, killAndAwaitExit } from "@cotal-ai/smoke-kit";

const space = `ord${mintLifecycleUid().slice(0, 8)}`;
const endpoint = "manager";
const caller = { owner: "local", actor: "seat", uid: mintLifecycleUid() };
const instanceId = mintLifecycleUid();
const epoch = 1;
const goalId = "goalorder1";
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  console.log(`${cond ? "ok" : "FAIL"} ${name}${cond || extra === undefined ? "" : ` ${JSON.stringify(extra)}`}`);
  if (cond) pass++; else fail++;
};
const enc = new TextEncoder();
const auth = await createSpaceAuth(space);
const brokerPort = await new Promise<number>((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const port = (probe.address() as AddressInfo).port;
    probe.close((err) => err ? reject(err) : resolve(port));
  });
});
const dir = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}goal-order-`));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], {
  host: "127.0.0.1", port: brokerPort, storeDir: join(dir, "js"), transport: { kind: "plaintext" },
}));
const followerIdentity = newIdentity();
const followerCreds = await mintCreds(auth, followerIdentity, "agent", {
  principal: { owner: caller.owner, actor: caller.actor }, lifecycleUid: caller.uid,
  allowPublish: [], allowSubscribe: [], capabilities: ["spawn"],
});
const publisherIdentity = newIdentity();
const publisherJwt = await encodeUser("goal-order-publisher", fromPublic(publisherIdentity.id), fromPublic(auth.account.pub), {
  pub: { allow: epServePublishRows(space, endpoint, instanceId, epoch) }, sub: { allow: ["_INBOX.>"] },
}, { signer: fromSeed(enc.encode(auth.account.signingSeed)) });
const publisherCreds = new TextDecoder().decode(fmtCreds(publisherJwt, fromSeed(enc.encode(publisherIdentity.seed))));
const broker = spawn("nats-server", ["-c", join(dir, "server.conf")], {
  stdio: "ignore", env: { PATH: process.env.PATH, HOME: dir, TMPDIR: dir },
});
const releaseBroker = teardownOnSignal(broker, dir);

class OrderedGate {
  held: Buffer[] = [];
  holding = false;
  ready = false;
  upstream?: Socket;
  constructor(public client: Socket) {}
  take(chunk: Buffer): void {
    if (!this.ready || this.holding) this.held.push(chunk);
    else this.upstream?.write(chunk);
  }
  release(): void {
    this.holding = false;
    if (this.ready && this.held.length) this.upstream?.write(Buffer.concat(this.held.splice(0)));
  }
}
const gates: OrderedGate[] = [];
const gate = createServer((client) => {
  const row = new OrderedGate(client);
  gates.push(row);
  const upstream = tcpConnect(brokerPort, "127.0.0.1");
  row.upstream = upstream;
  upstream.on("connect", () => { row.ready = true; row.release(); });
  client.on("data", (chunk) => row.take(chunk));
  upstream.on("data", (chunk) => client.write(chunk));
  const stop = () => { client.destroy(); upstream.destroy(); };
  client.on("error", stop); upstream.on("error", stop);
  client.on("close", () => upstream.destroy()); upstream.on("close", () => client.destroy());
});
function releaseHeld(): void {
  for (const row of gates) row.release();
}
const conns: NatsConnection[] = [];
const subject = (goal: string) => epeSubject(space, endpoint, instanceId, epoch, goalProgressTopic({ endpoint, caller, goalId: goal }));
const accepted = (goal: string): EpAttributedReply => ({ reply: { v: 1, id: goal, ok: true, data: { goalId: goal, readinessDeadlineMs: 0 } }, responder: { endpoint, instanceId, epoch } });
const body = (goal: string, name: string) => enc.encode(JSON.stringify({ phase: "terminal", goalId: goal, state: "succeeded", data: { name } }));
let watch: NodeJS.Timeout | undefined;
let barrierTimer: NodeJS.Timeout | undefined;

try {
  await new Promise<void>((resolve, reject) => {
    gate.once("error", reject);
    gate.listen(0, "127.0.0.1", resolve);
  });
  const gatePort = (gate.address() as AddressInfo).port;
  let up = false;
  const servers = `nats://127.0.0.1:${brokerPort}`;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(servers); if (!up) await new Promise((r) => setTimeout(r, 100)); }
  check("disposable broker reachable", up);
  const publisher = await connect({ servers, ...standaloneConnectOpts({ creds: publisherCreds, tls: false }), maxReconnectAttempts: 0, timeout: 4000 });
  conns.push(publisher);
  const follower = await connect({ servers: `nats://127.0.0.1:${gatePort}`, ...standaloneConnectOpts({ creds: followerCreds, tls: false }), maxReconnectAttempts: 0, timeout: 4000 });
  conns.push(follower);
  const violations: string[] = [];
  void (async () => { for await (const s of publisher.status()) if (s.type === "error") violations.push(String(s.error)); })().catch(() => {});

  const open = await submitAndFollowGoal(follower, space, endpoint, caller, 2000, async () => {
    publisher.publish(subject(goalId), body(goalId, "seat"));
    await publisher.flush();
    return accepted(goalId);
  });
  check("broker-confirmed standing subscription receives the borrowed terminal", open.reply.ok === true && (open.reply.data as { name?: string }).name === "seat", { reply: open.reply, violations });

  for (const row of gates) row.holding = true;
  let submits = 0;
  let submittedWhileHeld = false;
  let blocked: (() => void) | undefined;
  const blockedBytes = new Promise<void>((resolve) => { blocked = resolve; });
  watch = setInterval(() => {
    if (gates.some((row) => Buffer.concat(row.held).includes("SUB "))) { if (watch) clearInterval(watch); blocked?.(); }
  }, 5);
  const raced = submitAndFollowGoal(follower, space, endpoint, caller, 3000, async () => {
    submits++;
    submittedWhileHeld = gates.some((row) => row.holding);
    publisher.publish(subject("goalorder2"), body("goalorder2", "late"));
    await publisher.flush();
    return accepted("goalorder2");
  });
  const beforeRelease = await Promise.race([
    blockedBytes.then(() => "blocked"),
    raced.then(() => "submitted"),
    new Promise<string>((resolve) => { barrierTimer = setTimeout(() => resolve("timed-out"), 1000); }),
  ]);
  if (watch) clearInterval(watch);
  check("standing bytes block before borrowed submit", beforeRelease === "blocked" && submits === 0, { beforeRelease, submits });
  releaseHeld();
  const released = await raced;
  check("held standing subscription receives borrowed terminal after gate release", !submittedWhileHeld && submits === 1 && released.reply.ok === true && (released.reply.data as { name?: string }).name === "late" && violations.length === 0, { submittedWhileHeld, submits, reply: released.reply, violations });
} catch (e) {
  check("goal submit order completed", false, e instanceof Error ? e.message : String(e));
} finally {
  if (barrierTimer) clearTimeout(barrierTimer);
  if (watch) clearInterval(watch);
  releaseHeld();
  for (const nc of conns) await nc.close().catch(() => {});
  for (const row of gates) { row.client.destroy(); row.upstream?.destroy(); }
  await new Promise<void>((resolve) => gate.close(() => resolve()));
  await killAndAwaitExit(broker);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
}
if (pass + fail !== 4) throw new Error(`goal-submit-order executed ${pass + fail} cells, expected 4`);
console.log(`goal-submit-order smoke: ${pass} passed, ${fail} failed`);
emitSentinel({ passed: pass, failed: fail });
process.exit(fail === 0 ? 0 : 1);
