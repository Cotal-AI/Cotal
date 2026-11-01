/**
 * Stored copies for an agent that follows a channel FAMILY (`review.>`, #5404) against a REAL auth
 * broker with the delivery daemon's fan-out writer and trusted reader.
 *
 * Alice holds NO live subscription on any `review.*` channel, so a post reaches her only through the
 * durable backstop: fan-out → her inbox → the reader's re-check → DLV. Her membership rows are written
 * straight into the members registry, so each cell isolates the delivery path from the join path.
 *
 *  (1) A family row alone stores a post on a durable channel under the family.
 *  (2) A family row and the channel's own row together store ONE copy, even at different generations.
 *  (3) Leaving the channel's own row keeps delivery through the family; leaving both stops it.
 *  (4) A live-class channel under the family stores nothing (each channel's own class decides).
 *  (5) A read ACL narrowed below the family drops copies on the channels it no longer covers.
 *
 * Every "not stored" cell is closed by a later post that IS stored: the pipeline is in order, so the
 * marker arriving while the refused post never did is the proof.
 *
 * Run: pnpm smoke:channel-family:auth   (needs `nats-server` on PATH; auth/JetStream, local-only)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import {
  CotalEndpoint,
  isReachable,
  createSpaceAuth,
  mintCreds,
  provisionAgent,
  mintLifecycleUid,
  serverConfig,
  newIdentity,
  setupSpaceStreams,
  openMembersRegistry,
  openChannelRegistry,
  writeChannelConfig,
  commitMember,
  tombstoneMember,
  chatStream,
  DEV_OWNER,
  type MembershipRecord,
  type CotalMessage,
  type Delivery,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, timeoutMs = 8000, stepMs = 50): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) await wait(stepMs);
  return cond();
};
const awaitExit = (proc: ReturnType<typeof spawn>, timeoutMs = 3000): Promise<void> =>
  new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    proc.once("exit", () => resolve());
    setTimeout(resolve, timeoutMs);
  });
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

const space = `family-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);

try {
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);

  const mgrId = newIdentity();
  const mgrCreds = await mintCreds(auth, mgrId, "provisioner");
  await setupSpaceStreams({ servers: SERVERS, space, creds: mgrCreds });
  const mgr = new CotalEndpoint({
    space, servers: SERVERS, creds: mgrCreds,
    card: { id: mgrId.id, name: "mgr", kind: "endpoint" },
    channels: [], consume: false, registerPresence: false, watchPresence: false,
  });
  mgr.on("error", (e: Error) => console.error("  ! mgr", e.message));
  await mgr.start();
  const poster = new CotalEndpoint({
    space, servers: SERVERS, creds: await mintCreds(auth, newIdentity(), "operator"),
    card: { name: "poster", kind: "endpoint" }, channels: [], consume: false, registerPresence: false, watchPresence: false,
  });
  poster.on("error", (e: Error) => console.error("  ! poster", e.message));
  await poster.start();

  // `review.quiet` is live-class; every other channel takes the space default, durable.
  const writerId = newIdentity();
  const writerNc = await connect({
    servers: SERVERS,
    authenticator: credsAuthenticator(new TextEncoder().encode(await mintCreds(auth, writerId, "channel-writer"))),
    inboxPrefix: `_INBOX_${writerId.id}`,
    maxReconnectAttempts: 0,
  });
  await writeChannelConfig(await openChannelRegistry(writerNc, space), "review.quiet", { deliveryClass: "live" });
  await writerNc.close();

  const aId = newIdentity();
  const uidA = mintLifecycleUid();
  const aPrincipal = `${DEV_OWNER}.${aId.id}`;
  let aliceAcl = ["review.>"];
  const aCreds = await provisionAgent(mgr, auth, aId, { subscribe: [], allowSubscribe: ["review.>"], lifecycleUid: uidA });
  const dlvId = newIdentity();
  const dlv = new CotalEndpoint({
    space, servers: SERVERS, creds: await mintCreds(auth, dlvId, "delivery"),
    card: { id: dlvId.id, name: "delivery", role: "delivery", kind: "endpoint" },
    channels: [], consume: false, registerPresence: false, watchPresence: true,
  });
  dlv.on("error", (e: Error) => console.error("  ! dlv", e.message));
  await dlv.start();
  await dlv.startPlane3((owner) => (owner === aPrincipal ? aliceAcl : undefined));

  const a = new CotalEndpoint({
    space, servers: SERVERS, creds: aCreds,
    card: { id: aId.id, name: "alice", kind: "agent" },
    channels: [], lifecycleUid: uidA, heartbeatMs: 500, ttlMs: 2000,
  });
  const got: string[] = [];
  a.on("error", () => {});
  a.on("message", (m: CotalMessage, d: Delivery) => { got.push(m.parts.map((p) => (p.kind === "text" ? p.text : "")).join("")); d.ack(); });
  await a.start();
  await wait(400);

  // The members registry is the delivery daemon's to write; rows are planted with a `delivery` cred.
  const seedId = newIdentity();
  const kvNc = await connect({
    servers: SERVERS,
    authenticator: credsAuthenticator(new TextEncoder().encode(await mintCreds(auth, seedId, "delivery"))),
    inboxPrefix: `_INBOX_${seedId.id}`,
    maxReconnectAttempts: 0,
  });
  const kv = await openMembersRegistry(kvNc, space);
  const jsm = await jetstreamManager(kvNc);
  const frontier = async (): Promise<number> => (await jsm.streams.info(chatStream(space))).state.last_seq;
  const row = (channel: string, generation: number): MembershipRecord => ({
    channel, owner: aPrincipal, lifecycleUid: uidA, state: "durable-active", joinCursor: 0,
    generation, activated: true, writerIdentity: seedId.id, updatedAt: Date.now(),
  });
  const count = (text: string): number => got.filter((t) => t === text).length;
  const post = (text: string, channel: string) => poster.multicast(text, { channel });

  // ───────────── (1) a family row alone ─────────────
  await commitMember(kv, row("review.>", 1));
  await post("family-only", "review.a");
  check("a review.> row alone stores a post on review.a (fan-out routes the family row, the reader accepts it)",
    await until(() => got.includes("family-only")), got);

  // ───────────── (2) one copy for two covering rows ─────────────
  await commitMember(kv, row("review.a", 2));
  await post("two-rows", "review.a");
  await post("two-rows-marker", "review.b");
  await until(() => got.includes("two-rows-marker"));
  await wait(300);
  check("review.a's own row (generation 2) and review.> (generation 1) together store ONE copy",
    count("two-rows") === 1, got);

  // ───────────── (3) leave the channel's own row, then the family ─────────────
  await tombstoneMember(kv, "review.a", aPrincipal, uidA, await frontier(), seedId.id, 2);
  await post("after-own-leave", "review.a");
  check("after leaving review.a, review.> still stores its posts",
    await until(() => got.includes("after-own-leave")), got);
  await commitMember(kv, row("review.b", 1));
  await tombstoneMember(kv, "review.>", aPrincipal, uidA, await frontier(), seedId.id, 1);
  await post("after-both-left", "review.a");
  await post("both-left-marker", "review.b");
  await until(() => got.includes("both-left-marker"));
  await wait(300);
  check("after leaving review.a and review.>, review.a stores nothing (review.b's own row still does)",
    !got.includes("after-both-left") && got.includes("both-left-marker"), got);

  // ───────────── (4) a live-class channel under the family ─────────────
  await commitMember(kv, row("review.>", 2));
  await post("quiet-post", "review.quiet");
  await post("quiet-marker", "review.c");
  await until(() => got.includes("quiet-marker"));
  await wait(300);
  check("the live-class review.quiet stores nothing for a review.> follower, while durable review.c does",
    !got.includes("quiet-post") && got.includes("quiet-marker"), got);

  // ───────────── (5) a read ACL narrowed below the family ─────────────
  aliceAcl = ["review.b", "review.c"];
  await post("narrowed-out", "review.d");
  await post("narrowed-marker", "review.c");
  await until(() => got.includes("narrowed-marker"));
  await wait(300);
  check("a read ACL narrowed to review.b and review.c drops review.d's copy and keeps review.c's",
    !got.includes("narrowed-out") && got.includes("narrowed-marker"), got);

  await kvNc.close();
  await a.stop();
  await dlv.stop();
  await poster.stop();
  await mgr.stop();
  console.log(`\nCHANNEL-FAMILY SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
} finally {
  srv.kill("SIGKILL");
  await awaitExit(srv);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker(); // last: ownership is held until this teardown has actually finished
}
process.exit(fail === 0 ? 0 : 1);
