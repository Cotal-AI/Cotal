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
 * Then the join path, through the daemon's `ctl.delivery` and the agent's own join, leave and boot:
 *
 *  (6) A family join gets its row and stores later posts; `>`, `*` patterns, `team.**` and a family
 *      outside the read ACL are refused.
 *  (7) Two rows pending when a post lands (the post was routed by neither) both copy it on activation,
 *      at the same generation, and the agent keeps ONE copy.
 *  (8) A family's catch-up copies only durable-class channels, names each copy by its own channel, and
 *      keeps one copy beside a concrete row of another generation.
 *  (9) Catch-up on the daemon judges eviction per sender subject: a quiet old post cannot hide an
 *      evicted busy channel, a live-class channel at its cap does not count, and a concrete row's
 *      evicted window is reported too.
 * (10) With a live space default, a family is still joined durable, left with its row closed, and
 *      joined at boot; a `*` pattern says it stays live only.
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
  writeChannelDefaults,
  commitMember,
  readMember,
  tombstoneMember,
  chatStream,
  dlvStream,
  dlvSubject,
  MAX_MSGS_PER_SUBJECT,
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

  // The `*.quiet` channels are live-class; every other channel takes the space default, durable.
  const writerId = newIdentity();
  const writerNc = await connect({
    servers: SERVERS,
    authenticator: credsAuthenticator(new TextEncoder().encode(await mintCreds(auth, writerId, "channel-writer"))),
    inboxPrefix: `_INBOX_${writerId.id}`,
    maxReconnectAttempts: 0,
  });
  const channelKv = await openChannelRegistry(writerNc, space);
  for (const quiet of ["review.quiet", "dev.quiet", "bulk2.quiet"]) await writeChannelConfig(channelKv, quiet, { deliveryClass: "live" });

  // The reader's read ACL per principal; a cell narrows alice's.
  const acls = new Map<string, string[]>();
  const enrol = async (name: string, allowSubscribe: string[], subscribe: string[] = []) => {
    const id = newIdentity();
    const uid = mintLifecycleUid();
    const principal = `${DEV_OWNER}.${id.id}`;
    acls.set(principal, allowSubscribe);
    const creds = await provisionAgent(mgr, auth, id, { subscribe, allowSubscribe, lifecycleUid: uid });
    return { id, uid, principal, creds, name, subscribe };
  };
  const alice = await enrol("alice", ["review.>"]);
  const carol = await enrol("carol", ["team.>", "ops.>", "dev.>", "perm.*"]);
  const dave = await enrol("dave", ["bulk.>", "bulk2.>", "bulk3.>"]);
  const fred = await enrol("fred", ["flood.>"]);
  const erin = await enrol("erin", ["team.>"], ["team.>"]);
  const uidA = alice.uid, aPrincipal = alice.principal;
  const dlvId = newIdentity();
  const dlv = new CotalEndpoint({
    space, servers: SERVERS, creds: await mintCreds(auth, dlvId, "delivery"),
    card: { id: dlvId.id, name: "delivery", role: "delivery", kind: "endpoint" },
    channels: [], consume: false, registerPresence: false, watchPresence: true,
  });
  dlv.on("error", (e: Error) => console.error("  ! dlv", e.message));
  await dlv.start();
  await dlv.startPlane3((owner) => acls.get(owner));

  const launch = async (who: typeof alice) => {
    const ep = new CotalEndpoint({
      space, servers: SERVERS, creds: who.creds,
      card: { id: who.id.id, name: who.name, kind: "agent" },
      channels: who.subscribe, lifecycleUid: who.uid, heartbeatMs: 500, ttlMs: 2000,
    });
    const texts: string[] = [];
    ep.on("error", () => {});
    ep.on("message", (m: CotalMessage, d: Delivery) => { texts.push(m.parts.map((p) => (p.kind === "text" ? p.text : "")).join("")); d.ack(); });
    await ep.start();
    return { ep, texts };
  };
  const { ep: a, texts: got } = await launch(alice);
  const { ep: c, texts: gotC } = await launch(carol);
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
  const pendingRow = (who: typeof alice, channel: string, generation: number, joinCursor: number): MembershipRecord => ({
    channel, owner: who.principal, lifecycleUid: who.uid, state: "durable-active", joinCursor,
    generation, activated: false, writerIdentity: seedId.id, updatedAt: Date.now(),
  });
  const count = (text: string): number => got.filter((t) => t === text).length;
  const countC = (text: string): number => gotC.filter((t) => t === text).length;
  const refusal = async (p: Promise<unknown>): Promise<string> => { try { await p; return ""; } catch (e) { return (e as Error).message; } };
  // A refused join fails its own cell rather than ending the run.
  const join = (p: Promise<{ durable: boolean; reason?: string }>) => p.catch((e: Error) => ({ durable: false, reason: `refused: ${e.message}` }));
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

  // ───────────── (4b) channelMembers counts a family row on durable channels, once per principal ─────────────
  // alice now holds review.> and review.b's own row.
  const membersOf = async (channel: string) => (await dlv.channelMembers(channel)).filter((m) => m.id === aPrincipal || m.id === alice.id.id).length;
  check("channelMembers lists alice once on review.b, which her own row and review.> both cover", (await membersOf("review.b")) === 1, await dlv.channelMembers("review.b"));
  check("channelMembers lists alice on the durable review.c through review.> alone", (await membersOf("review.c")) === 1, await dlv.channelMembers("review.c"));
  check("channelMembers leaves alice off the live-class review.quiet, where review.> stores nothing", (await membersOf("review.quiet")) === 0, await dlv.channelMembers("review.quiet"));

  // ───────────── (5) a read ACL narrowed below the family ─────────────
  acls.set(aPrincipal, ["review.b", "review.c"]);
  await post("narrowed-out", "review.d");
  await post("narrowed-marker", "review.c");
  await until(() => got.includes("narrowed-marker"));
  await wait(300);
  check("a read ACL narrowed to review.b and review.c drops review.d's copy and keeps review.c's",
    !got.includes("narrowed-out") && got.includes("narrowed-marker"), got);

  // ───────────── (6) a family join through the daemon, and its refusals ─────────────
  const joinedTeam = await join(c.durableJoinChannel("team.>"));
  check("carol's durable join of team.> is accepted and active", joinedTeam.durable === true, joinedTeam);
  await post("team-after-join", "team.a");
  check("a post on team.a after the join is stored for carol (she holds no live subscription)",
    await until(() => gotC.includes("team-after-join")), gotC);
  const refusals = await Promise.all([">", "team.*.>", "team.*"].map((ch) => refusal(c.durableJoinChannel(ch))));
  check("the daemon refuses >, team.*.> and team.* as durable memberships, saying they stay live only",
    refusals.every((r) => r.includes("stays live only")), refusals);
  check("the daemon refuses team.** as no valid channel", (await refusal(c.durableJoinChannel("team.**"))).includes("NATS-safe token"));
  check("the daemon refuses a family outside the read ACL (secret.>)",
    (await refusal(c.durableJoinChannel("secret.>"))).includes("not within your read ACL"));
  check("the daemon refuses perm.> under a perm.* grant, which cannot read perm.a.b",
    (await refusal(c.durableJoinChannel("perm.>"))).includes("not within your read ACL"));

  // ───────────── (7) two rows pending when a post lands, activated at once ─────────────
  // The post lands before either row exists, so fan-out routes it to nobody; both rows are then
  // written pending with a join cursor before it, as two joins in flight would leave them.
  await post("pending-same", "ops.b");
  const sameSeq = await frontier();
  await post("pending-same-marker", "team.a");
  await until(() => gotC.includes("pending-same-marker"));
  await commitMember(kv, pendingRow(carol, "ops.b", 1, sameSeq - 1));
  await commitMember(kv, pendingRow(carol, "ops.>", 1, sameSeq - 1));
  const [own, fam] = await Promise.all([join(c.durableJoinChannel("ops.b")), join(c.durableJoinChannel("ops.>"))]);
  check("ops.b and ops.> pending at generation 1 both activate when re-joined together",
    own.durable === true && fam.durable === true, { own, fam });
  await post("pending-same-after", "team.a");
  await until(() => gotC.includes("pending-same-after"));
  await wait(300);
  check("the post both pending rows covered is stored once", countC("pending-same") === 1, gotC);

  // ───────────── (8) family catch-up: by class, named per post, one copy across generations ─────────────
  const devFrom = await frontier();
  await post("dev-own", "dev.c");
  await post("dev-family-only", "dev.d");
  await post("dev-quiet", "dev.quiet");
  await post("dev-marker", "team.a");
  await until(() => gotC.includes("dev-marker"));
  await commitMember(kv, pendingRow(carol, "dev.>", 1, devFrom));
  await commitMember(kv, pendingRow(carol, "dev.c", 2, devFrom));
  const devFam = await join(c.durableJoinChannel("dev.>"));
  const devOwn = await join(c.durableJoinChannel("dev.c"));
  await post("dev-after", "team.a");
  await until(() => gotC.includes("dev-after"));
  await wait(300);
  check("dev.> and dev.c activate", devFam.durable === true && devOwn.durable === true, { devFam, devOwn });
  check("dev.> catch-up stores dev.d's post, which only the family covers (each copy names its own channel)",
    countC("dev-family-only") === 1, gotC);
  check("dev.c's post, covered by dev.> (generation 1) and dev.c (generation 2), is stored once",
    countC("dev-own") === 1, gotC);
  check("dev.> catch-up leaves out the live-class dev.quiet", !gotC.includes("dev-quiet"), gotC);

  // ───────────── (9) family catch-up eviction, per sender subject ─────────────
  // Dave never connects; the daemon runs his joins directly.
  await post("bulk-old", "bulk.old");
  const bulkFrom = await frontier();
  for (let i = 0; i <= 1000; i++) await post(`busy-${i}`, "bulk.busy");
  await commitMember(kv, pendingRow(dave, "bulk.>", 1, bulkFrom));
  const evicted = await join(dlv.durableJoinFor(dave.principal, "bulk.>", dave.uid));
  check("bulk.> reports its window evicted: bulk.busy lost posts past its cap, and bulk.old's older post does not hide it",
    evicted.durable === false && /evicted/.test(evicted.reason ?? ""), evicted);
  const quietFrom = await frontier();
  for (let i = 0; i <= 1000; i++) await post(`quiet-${i}`, "bulk2.quiet");
  await commitMember(kv, pendingRow(dave, "bulk2.>", 1, quietFrom));
  const liveOnly = await join(dlv.durableJoinFor(dave.principal, "bulk2.>", dave.uid));
  check("bulk2.> stays complete: the live-class bulk2.quiet at its cap does not count", liveOnly.durable === true, liveOnly);
  // A concrete channel's catch-up on the daemon is judged the same way.
  const soloFrom = await frontier();
  for (let i = 0; i <= 1000; i++) await post(`solo-${i}`, "bulk3.solo");
  await commitMember(kv, pendingRow(dave, "bulk3.solo", 1, soloFrom));
  const soloEvicted = await join(dlv.durableJoinFor(dave.principal, "bulk3.solo", dave.uid));
  check("bulk3.solo reports its window evicted after one sender's 1001 posts (a concrete row's catch-up on the daemon)",
    soloEvicted.durable === false && /evicted/.test(soloEvicted.reason ?? ""), soloEvicted);

  // ───────────── (10) a live space default ─────────────
  await writeChannelDefaults(channelKv, { deliveryClass: "live" });
  await wait(500); // the agents' channel registry watch picks up the new default
  const joinedLive = await join(c.joinChannel("team.x.>"));
  const teamX = await readMember(kv, "team.x.>", carol.principal, carol.uid);
  check("with a live default, joining team.x.> still asks for and gets its family row",
    joinedLive.durable === true && teamX?.record.activated === true && teamX.record.leaveCursor === undefined, { joinedLive, teamX });
  await c.leaveChannel("team.x.>").catch(() => undefined);
  check("leaving team.x.> with a live default closes its family row",
    (await readMember(kv, "team.x.>", carol.principal, carol.uid))?.record.leaveCursor !== undefined);
  const starJoin = await join(c.joinChannel("team.*"));
  check("joining team.* says a * pattern stays live only", starJoin.durable === false && /pattern with \*/.test(starJoin.reason ?? ""), starJoin);
  const { ep: e } = await launch(erin);
  let erinRow: Awaited<ReturnType<typeof readMember>> = undefined;
  for (let i = 0; i < 40 && (erinRow = await readMember(kv, "team.>", erin.principal, erin.uid))?.record.activated !== true; i++) await wait(200);
  check("an agent booted on team.> with a live default holds its family row", erinRow?.record.activated === true, erinRow);

  // ───────────── (11) a full store says so once (decision 3) ─────────────
  // fred follows flood.> and is away while 1100 posts land on the durable flood.x, so his store holds
  // its limit of 1000 and older copies are gone. On connect the endpoint says so, and the post after
  // the store drained says nothing more. Away again for 5 posts, his next connect says nothing.
  await writeChannelConfig(channelKv, "flood.x", { deliveryClass: "durable" });
  await commitMember(kv, { ...pendingRow(fred, "flood.>", 1, await frontier()), activated: true });
  for (let i = 0; i < 1100; i++) await post(`flood-${i}`, "flood.x");
  const fredSubject = dlvSubject(space, DEV_OWNER, fred.id.id, fred.uid);
  const stored = async (): Promise<number> =>
    (await jsm.streams.info(dlvStream(space), { subjects_filter: fredSubject })).state.subjects?.[fredSubject] ?? 0;
  let held = 0;
  for (let i = 0; i < 300 && (held = await stored()) < MAX_MSGS_PER_SUBJECT; i++) await wait(200);
  let notices = 0;
  const fredEp = new CotalEndpoint({
    space, servers: SERVERS, creds: fred.creds, card: { id: fred.id.id, name: fred.name, kind: "agent" },
    channels: [], lifecycleUid: fred.uid, heartbeatMs: 500, ttlMs: 2000,
  });
  const gotF: string[] = [];
  fredEp.on("error", () => {});
  fredEp.on("stored-copies-full", () => notices++);
  fredEp.on("message", (m: CotalMessage, d: Delivery) => { gotF.push(m.parts.map((p) => (p.kind === "text" ? p.text : "")).join("")); d.ack(); });
  await fredEp.start();
  await until(() => gotF.includes("flood-1099"), 60_000);
  const drained = notices;
  await post("after-drain", "flood.x");
  await until(() => gotF.includes("after-drain"), 10_000);
  // The reader may still be moving copies when fred connects, so he can read more than 1000, never all 1100.
  const floods = gotF.filter((t) => t.startsWith("flood-")).length;
  check(`fred's store held its limit of ${MAX_MSGS_PER_SUBJECT}, older copies were gone, and he read the newest post`,
    held === MAX_MSGS_PER_SUBJECT && floods < 1100 && gotF.includes("flood-1099"), { held, floods });
  check("the endpoint said the store was full, and nothing more for the post after it drained", drained >= 1 && notices === drained && gotF.includes("after-drain"), { drained, notices });
  await fredEp.stop();
  for (let i = 0; i < 5; i++) await post(`small-${i}`, "flood.x");
  let smallNotices = 0;
  const fredAgain = new CotalEndpoint({
    space, servers: SERVERS, creds: fred.creds, card: { id: fred.id.id, name: fred.name, kind: "agent" },
    channels: [], lifecycleUid: fred.uid, heartbeatMs: 500, ttlMs: 2000,
  });
  const gotAgain: string[] = [];
  fredAgain.on("error", () => {});
  fredAgain.on("stored-copies-full", () => smallNotices++);
  fredAgain.on("message", (m: CotalMessage, d: Delivery) => { gotAgain.push(m.parts.map((p) => (p.kind === "text" ? p.text : "")).join("")); d.ack(); });
  await fredAgain.start();
  await until(() => gotAgain.includes("small-4"), 15_000);
  check("a store of 5 copies gives no notice on the next connect", gotAgain.includes("small-4") && smallNotices === 0, { smallNotices, got: gotAgain.length });
  await fredAgain.stop();

  await writerNc.close();
  await kvNc.close();
  await e.stop();
  await c.stop();
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
