/**
 * History reads on the observer and admin profiles leave no consumers behind (#4123).
 *
 * `channelHistory`, `multiChannelHistory` and `dmHistory` read through JetStream consumers. The
 * observer and admin profiles held no `CONSUMER.DELETE` on any stream (#691), so every read left
 * its consumers to the broker's five-minute inactive threshold. A dashboard polling every few
 * seconds then filled the stream's consumer limit, and every later read failed with "maximum
 * consumers limit reached". The readers now use consumer names the credential may delete, and only
 * those names.
 *
 * The suite lowers `max_consumers` on CHAT and DM to a small cap and reads past it, sequentially
 * and concurrently. It asserts that every read answers, that the consumer counts return to the
 * baseline, and that the delete grant reaches no consumer outside the reader's own names. It then
 * takes the reader's names with consumers it did not create, which a read must step around and never
 * delete. That includes a reader left under the read's own name with the very config the read sends,
 * which NATS hands back on create as if it were new, and a consumer another holder of the same
 * credential creates under a name whose delete answer this endpoint lost. It reads on a credential
 * minted without the delete rows, which must fail and say to remint rather than leave a reader per
 * read. Last, it repeats the hosted dashboard's request, one read per channel across 195 channels at
 * once, against the broker's 1,000-consumer limit.
 *
 * Run: pnpm smoke:history-reader-consumers:auth   (needs `nats-server` on PATH; auth/JetStream, local-only)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer, connect as netConnect, type Socket } from "node:net";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator, nanos } from "@nats-io/transport-node";
import { AckPolicy, DeliverPolicy, jetstream, jetstreamManager } from "@nats-io/jetstream";
import { encodeUser, fmtCreds } from "@nats-io/jwt";
import { fromPublic, fromSeed } from "@nats-io/nkeys";
import {
  CotalEndpoint, isReachable, createSpaceAuth, mintCreds, provisionAgent, mintLifecycleUid,
  serverConfig, newIdentity, setupSpaceStreams, seedChannelRegistry, principalKey, DEV_OWNER,
  chatStream, chatSubject, dmStream, historyReaderConsumer, HISTORY_READERS, permissionsFor, type CotalMessage,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, createSuite, teardownOnSignal } from "@cotal-ai/smoke-kit";

const textOf = (m: CotalMessage) => m.parts.map((p) => (p.kind === "text" ? p.text : "")).join("");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const enc = (s: string) => new TextEncoder().encode(s);
const { check, finish } = createSuite();

/** A TCP relay to the broker whose broker-to-client direction can be held. Once the client sends a
 *  frame containing the armed marker, what the broker sends back is kept until `release`: the request
 *  in that frame still runs on the broker, and its answer reaches the client only after the client
 *  has given up on it. */
async function holdableRelay(brokerPort: number) {
  const sockets = new Set<Socket>();
  const held: { to: Socket; data: Buffer }[] = [];
  let marker: string | undefined;
  let holding = false;
  const server = createServer((client) => {
    const broker = netConnect(brokerPort, "127.0.0.1");
    sockets.add(client); sockets.add(broker);
    client.on("data", (d) => {
      if (marker !== undefined && d.includes(marker)) { holding = true; marker = undefined; }
      broker.write(d);
    });
    broker.on("data", (d) => { if (holding) held.push({ to: client, data: d }); else client.write(d); });
    const end = () => { client.destroy(); broker.destroy(); };
    for (const s of [client, broker]) { s.on("close", end); s.on("error", end); }
  });
  const port = await pickFreePort();
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    url: `nats://127.0.0.1:${port}`,
    holdAfter(m: string) { marker = m; },
    release() { holding = false; for (const { to, data } of held.splice(0)) to.write(data); },
    close() { for (const s of sockets) s.destroy(); server.close(); },
  };
}

/** The consumer limit the suite sets on CHAT and DM. Each read used to leave two or three
 *  consumers, so this many reads past the cap fails within the first few. */
const CAP = 12;
const READS = 3 * CAP;
/** The hosted dashboard's shape, measured on the dev stack: one history read per channel for each
 *  request, over 195 channels, against the broker's 1,000-consumer stream limit. */
const FANOUT_CHANNELS = 195;
const FANOUT_REQUESTS = 3;
const FANOUT_CAP = 1_000;
const fanoutChannels = Array.from({ length: FANOUT_CHANNELS }, (_, i) => `fan.c${i}`);

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const space = `hist-readers-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);

const endpoints: CotalEndpoint[] = [];
const raws: Awaited<ReturnType<typeof connect>>[] = [];
const relays: Awaited<ReturnType<typeof holdableRelay>>[] = [];
try {
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);

  const mgrCreds = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: SERVERS, space, creds: mgrCreds });
  await seedChannelRegistry({
    servers: SERVERS, space, creds: mgrCreds,
    file: { defaults: { replay: true }, channels: { "team.ops": { replay: true }, general: { replay: true }, ...Object.fromEntries(fanoutChannels.map((c) => [c, { replay: true }])) } },
  });
  const mgr = new CotalEndpoint({ space, servers: SERVERS, creds: mgrCreds, channels: [], consume: false, watchPresence: false, registerPresence: false, card: { name: "prov", role: "manager", kind: "endpoint" } });
  mgr.on("error", () => {}); await mgr.start(); endpoints.push(mgr);

  const start = async (creds: string, name: string, extra: Record<string, unknown> = {}) => {
    const ep = new CotalEndpoint({ space, servers: SERVERS, creds, channels: [], consume: false, watchPresence: false, registerPresence: false, watchChannels: false, card: { name, kind: "endpoint" }, ...extra });
    ep.on("error", () => {}); await ep.start(); endpoints.push(ep);
    return ep;
  };

  // A backlog on two channels and in DMs. `team.ops` is a two-token channel, like the channel the
  // hosted dashboard failed to read.
  const pId = newIdentity(), uidP = mintLifecycleUid();
  const pCreds = await provisionAgent(mgr, auth, pId, { allowSubscribe: ["team.ops", "general"], allowPublish: ["team.ops", "general", ...fanoutChannels], subscribe: [], lifecycleUid: uidP });
  const poster = await start(pCreds, "poster", { lifecycleUid: uidP, card: { id: pId.id, name: "poster", kind: "agent" } });
  const tId = newIdentity(), uidT = mintLifecycleUid();
  await provisionAgent(mgr, auth, tId, { allowSubscribe: [], subscribe: [], lifecycleUid: uidT });
  for (let i = 1; i <= 30; i++) await poster.multicast(`ops ${i}`, { channel: "team.ops" });
  for (let i = 1; i <= 10; i++) await poster.multicast(`general ${i}`, { channel: "general" });
  for (let i = 1; i <= 10; i++) await poster.unicast(principalKey(DEV_OWNER, tId.id).key, `dm ${i}`);
  for (const c of fanoutChannels) for (let i = 1; i <= 3; i++) await poster.multicast(`${c} ${i}`, { channel: c });

  // A test-only allow-all inspector: it lowers the caps and counts consumers, which no shipped
  // profile may do on these streams.
  const inspId = newIdentity();
  const inspJwt = await encodeUser("history-inspector", fromPublic(inspId.id), fromPublic(auth.account.pub),
    { pub: { allow: [">"] }, sub: { allow: [">"] } }, { signer: fromSeed(new TextEncoder().encode(auth.account.signingSeed)) });
  const inspCreds = fmtCreds(inspJwt, fromSeed(new TextEncoder().encode(inspId.seed)));
  const control = await connect({ servers: SERVERS, authenticator: credsAuthenticator(inspCreds), maxReconnectAttempts: 0 });
  raws.push(control);
  const jsm = await jetstreamManager(control);
  // nats.js types `max_consumers` as create-only. nats-server 2.15 applies the change to a live
  // stream (measured), and that is the cap the reads below run into.
  const setCap = async (stream: string, cap: number) => {
    const { config } = await jsm.streams.info(stream);
    await jsm.streams.update(stream, { ...config, max_consumers: cap } as Parameters<typeof jsm.streams.update>[1]);
  };
  for (const stream of [chatStream(space), dmStream(space)]) await setCap(stream, CAP);
  const count = async (stream: string) => (await jsm.streams.info(stream)).state.consumer_count;
  const chatBase = await count(chatStream(space));
  const dmBase = await count(dmStream(space));
  check("positive control: both streams now refuse consumers past the test cap",
    (await jsm.streams.info(chatStream(space))).config.max_consumers === CAP && (await jsm.streams.info(dmStream(space))).config.max_consumers === CAP,
    { chatBase, dmBase });

  const obsId = newIdentity();
  const observer = await start(await mintCreds(auth, obsId, "observer"), "observer");
  const admId = newIdentity();
  const admin = await start(await mintCreds(auth, admId, "admin"), "admin");

  // 1. A read answers with the newest page, which is what the rest of the suite repeats.
  const page = await observer.channelHistory("team.ops", { limit: 5 });
  check("positive control: the observer reads the newest page of a channel",
    page.map(textOf).join("|") === "ops 26|ops 27|ops 28|ops 29|ops 30", page.map(textOf));

  /** Run `read` `n` times in sequence and report how many answered and the first refusal. */
  const repeat = async (n: number, read: () => Promise<unknown[]>, want: number) => {
    let answered = 0;
    let first: string | undefined;
    for (let i = 0; i < n; i++) {
      try { if ((await read()).length === want) answered++; else first ??= `short page on read ${i + 1}`; }
      catch (e) { first ??= `read ${i + 1}: ${(e as Error).message}`; }
    }
    return { answered, first };
  };

  // 2. Sequential reads past the cap. Each read used to leave its consumers behind.
  const single = await repeat(READS, () => observer.channelHistory("team.ops", { limit: 5 }), 5);
  check(`observer: ${READS} sequential channelHistory reads past a cap of ${CAP} all answer`, single.answered === READS, single);
  const chatAfterSingle = await count(chatStream(space));
  check("observer: the CHAT consumer count is back to its baseline after them", chatAfterSingle === chatBase, { chatBase, chatAfterSingle });

  const multi = await repeat(READS, () => observer.multiChannelHistory(["team.ops", "general"], { limit: 8 }), 8);
  check(`observer: ${READS} sequential multiChannelHistory reads all answer`, multi.answered === READS, multi);
  const chatAfterMulti = await count(chatStream(space));
  check("observer: the CHAT consumer count is back to its baseline after them", chatAfterMulti === chatBase, { chatBase, chatAfterMulti });

  const dms = await repeat(READS, () => admin.dmHistory({ limit: 4 }), 4);
  check(`admin: ${READS} sequential dmHistory reads past a cap of ${CAP} all answer`, dms.answered === READS, dms);
  const dmAfter = await count(dmStream(space));
  check("admin: the DM consumer count is back to its baseline after them", dmAfter === dmBase, { dmBase, dmAfter });

  // 3. Concurrent reads beyond the reader pool. They wait for a free name rather than fail, the
  // live count never exceeds the pool, and nothing is left when they finish.
  let peak = 0;
  let sampling = true;
  const sampler = (async () => { while (sampling) { peak = Math.max(peak, await count(chatStream(space))); await wait(2); } })();
  const burst = await Promise.allSettled(Array.from({ length: 3 * HISTORY_READERS }, (_, i) =>
    i % 2 === 0 ? observer.channelHistory("team.ops", { limit: 5 }) : observer.multiChannelHistory(["team.ops", "general"], { limit: 8 })));
  sampling = false; await sampler;
  const burstOk = burst.filter((r, i) => r.status === "fulfilled" && r.value.length === (i % 2 === 0 ? 5 : 8)).length;
  check(`observer: ${burst.length} concurrent reads all answer`, burstOk === burst.length,
    burst.map((r) => (r.status === "rejected" ? (r.reason as Error).message : r.value.length)));
  check(`observer: concurrent reads hold at most ${HISTORY_READERS} consumers at once`, peak - chatBase <= HISTORY_READERS, { peak, chatBase });
  const chatAfterBurst = await count(chatStream(space));
  check("observer: the CHAT consumer count is back to its baseline after the burst", chatAfterBurst === chatBase, { chatBase, chatAfterBurst });

  // 4. The delete grant reaches the reader's own names and nothing else. A consumer under another
  // connection's reader name, and an ordinary named consumer, both survive the observer's delete.
  // The cap is lifted first so these cells run whatever the reads above left behind.
  await setCap(chatStream(space), -1);
  // Take a consumer name as another holder would. A name a reader left behind already counts.
  const take = async (name: string) => {
    try { await jsm.consumers.add(chatStream(space), { name, ack_policy: AckPolicy.None, mem_storage: true, inactive_threshold: 60_000_000_000 }); }
    catch (e) { if (!/already exists/.test((e as Error).message)) throw e; }
  };
  const other = historyReaderConsumer(newIdentity().id, 0);
  for (const name of [other, "bystander"]) await take(name);
  const obsNc = await connect({ servers: SERVERS, authenticator: credsAuthenticator(new TextEncoder().encode(await mintCreds(auth, obsId, "observer"))), inboxPrefix: `_INBOX_${obsId.id}` });
  raws.push(obsNc);
  const obsJsm = await jetstreamManager(obsNc);
  const refused = async (name: string) => {
    try { await obsJsm.consumers.delete(chatStream(space), name); return "deleted"; }
    catch (e) { return (e as Error).message; }
  };
  for (const name of [other, "bystander"]) {
    const outcome = await refused(name);
    const still = await jsm.consumers.info(chatStream(space), name).then(() => true, () => false);
    check(`observer: deleting ${name === other ? "another connection's reader name" : "a bystander consumer"} is refused and it survives`,
      /permission/i.test(outcome) && still, { outcome, still });
  }
  const own = historyReaderConsumer(obsId.id, 0);
  await take(own);
  const ownOutcome = await refused(own);
  check("observer: deleting its own reader name is allowed", ownOutcome === "deleted", ownOutcome);

  // 5. A reader name already in use belongs to someone else: another process on this credential, or
  // one that stopped mid-read. The read moves to a free name and leaves that consumer alone. With
  // every name taken it fails at once and says why, rather than waiting for names no read here
  // will give back.
  const exists = async (name: string) => jsm.consumers.info(chatStream(space), name).then(() => true, () => false);
  const taken = Array.from({ length: HISTORY_READERS - 1 }, (_, i) => historyReaderConsumer(obsId.id, i + 1));
  for (const name of taken) await take(name);
  const hopped = await observer.channelHistory("team.ops", { limit: 5 }).then((r) => r.length, (e: Error) => e.message);
  const survivors = (await Promise.all(taken.map(exists))).filter(Boolean).length;
  check(`observer: with ${taken.length} of its ${HISTORY_READERS} reader names taken, a read still answers on the free one`, hopped === 5, hopped);
  check("observer: ...and every consumer under a taken name survives it", survivors === taken.length, { survivors });
  await take(own);
  const t0 = Date.now();
  const blocked = await observer.channelHistory("team.ops", { limit: 5 }).then((r) => `answered ${r.length}`, (e: Error) => e.message);
  check("observer: with every reader name taken, the read fails at once and names the cause",
    /did not create/.test(blocked) && Date.now() - t0 < 5_000, { blocked, ms: Date.now() - t0 });
  check("observer: ...and still deletes none of them", (await Promise.all([own, ...taken].map(exists))).every(Boolean));

  // 5b. A reader left under the read's own name with the very config the read sends. NATS answers a
  // create whose config equals the existing consumer's with that consumer, delivery state and all, so
  // the read would be handed a reader that has already delivered its one message and reports nothing
  // pending, which reads as an empty channel. The read must answer the true page and leave that
  // consumer alone, since nothing tells it who left it.
  const leftId = newIdentity();
  const leftName = historyReaderConsumer(leftId.id, 0);
  await jsm.consumers.add(chatStream(space), {
    name: leftName, filter_subjects: [chatSubject(space, "*", "*", "team.ops")], deliver_policy: DeliverPolicy.Last,
    ack_policy: AckPolicy.None, max_deliver: 1, mem_storage: true, num_replicas: 1, inactive_threshold: nanos(5 * 60_000),
  });
  let leftDelivered = 0;
  for await (const _ of await (await jetstream(control).consumers.get(chatStream(space), leftName)).fetch({ max_messages: 1, expires: 2_000 })) leftDelivered++;
  const leftReader = await start(await mintCreds(auth, leftId, "observer"), "left-reader");
  const leftPage = await leftReader.channelHistory("team.ops", { limit: 5 }).then((r) => r.map(textOf).join("|"), (e: Error) => e.message);
  check("positive control: the reader left under the name has delivered its message", leftDelivered === 1, leftDelivered);
  check("observer: a reader left under its own name with the read's own config is not reused, and the read answers the true page",
    leftPage === "ops 26|ops 27|ops 28|ops 29|ops 30", leftPage);
  check("observer: ...and the reader left under the name is not deleted", await exists(leftName));

  // 5c. A delete whose answer is lost. Two processes share one static credential, so they share
  // reader names. This endpoint's delete runs on the broker, but the answer never arrives, so it
  // cannot tell whether its reader is gone. The other process then takes the freed name for a read of
  // its own. Nothing this endpoint knows tells that consumer from its own, so it must never delete it.
  const sharedId = newIdentity();
  const sharedCreds = await mintCreds(auth, sharedId, "observer");
  const link = await holdableRelay(PORT);
  relays.push(link);
  const lossy = await start(sharedCreds, "lossy-reader", { servers: link.url });
  link.holdAfter("$JS.API.CONSUMER.DELETE.");
  const lost = await lossy.channelHistory("team.ops", { limit: 5 }).then((r) => `answered ${r.length}`, (e: Error) => e.message);
  link.release();
  const sharedName = historyReaderConsumer(sharedId.id, 0);
  const goneOnBroker = !(await exists(sharedName));
  check("positive control: the held delete ran on the broker, and the read that lost its answer failed", goneOnBroker && !lost.startsWith("answered"), { lost, goneOnBroker });
  const otherHolder = await connect({ servers: SERVERS, authenticator: credsAuthenticator(enc(sharedCreds)), inboxPrefix: `_INBOX_${sharedId.id}` });
  raws.push(otherHolder);
  await (await jetstreamManager(otherHolder)).consumers.add(chatStream(space), { name: sharedName, ack_policy: AckPolicy.None, mem_storage: true, inactive_threshold: nanos(60_000) });
  const afterLost = await lossy.channelHistory("team.ops", { limit: 5 }).then((r) => r.length, (e: Error) => e.message);
  check("shared credential: the next read answers", afterLost === 5, afterLost);
  check("shared credential: ...and the consumer the other holder created under the name survives it", await exists(sharedName));

  // 6. A credential minted before the reader deletes existed. Its reads cannot clean up, so they
  // fail and say to remint, and they leave one reader behind rather than one per read.
  const oldId = newIdentity();
  const current = permissionsFor("observer", space, { owner: DEV_OWNER, actor: oldId.id, connId: oldId.id }, {}) as { pub: { allow: string[] }; sub: { allow: string[] } };
  const oldJwt = await encodeUser("pre-reader-delete-observer", fromPublic(oldId.id), fromPublic(auth.account.pub),
    { pub: { allow: current.pub.allow.filter((row) => !row.includes(".hist_")) }, sub: current.sub },
    { signer: fromSeed(new TextEncoder().encode(auth.account.signingSeed)) });
  const oldObserver = await start(new TextDecoder().decode(fmtCreds(oldJwt, fromSeed(new TextEncoder().encode(oldId.seed)))), "old-observer");
  const left = async () => {
    let n = 0;
    for await (const info of jsm.consumers.list(chatStream(space))) if (info.name.startsWith(`hist_${oldId.id}_`)) n++;
    return n;
  };
  const firstOld = await oldObserver.channelHistory("team.ops", { limit: 5 }).then((r) => `answered ${r.length}`, (e: Error) => e.message);
  const leftAfterFirst = await left();
  const secondOld = await oldObserver.channelHistory("team.ops", { limit: 5 }).then((r) => `answered ${r.length}`, (e: Error) => e.message);
  const leftAfterSecond = await left();
  check("old credential: the read fails and says to remint", /remint it/.test(firstOld), firstOld);
  check("old credential: a second read fails the same way and leaves no further reader",
    /remint it/.test(secondOld) && leftAfterFirst === 1 && leftAfterSecond === 1, { secondOld, leftAfterFirst, leftAfterSecond });

  // 7. The hosted dashboard's fan-out at its own scale: each request reads every channel at once,
  // against the broker's real limit. The reader above that could not delete is set aside first, so
  // only this connection's reads are counted.
  await oldObserver.stop(); endpoints.splice(endpoints.indexOf(oldObserver), 1);
  await setCap(chatStream(space), FANOUT_CAP);
  const fanReader = await start(await mintCreds(auth, newIdentity(), "observer"), "fan-reader");
  const fanBase = await count(chatStream(space));
  let fanPeak = fanBase;
  let fanSampling = true;
  const fanSampler = (async () => { while (fanSampling) { fanPeak = Math.max(fanPeak, await count(chatStream(space))); await wait(5); } })();
  const fanAnswered: number[] = [];
  const fanAfter: number[] = [];
  let fanFirst: string | undefined;
  for (let r = 0; r < FANOUT_REQUESTS; r++) {
    const pages = await Promise.allSettled(fanoutChannels.map((c) => fanReader.channelHistory(c, { limit: 50 })));
    fanAnswered.push(pages.filter((p) => p.status === "fulfilled" && p.value.length === 3).length);
    fanFirst ??= pages.flatMap((p) => (p.status === "rejected" ? [(p.reason as Error).message] : []))[0];
    fanAfter.push(await count(chatStream(space)) - fanBase);
  }
  fanSampling = false; await fanSampler;
  check(`fan-out: ${FANOUT_REQUESTS} requests of ${FANOUT_CHANNELS} concurrent channel reads all answer under a ${FANOUT_CAP}-consumer limit`,
    fanAnswered.every((n) => n === FANOUT_CHANNELS), { fanAnswered, fanFirst });
  check("fan-out: no request leaves a consumer behind", fanAfter.every((n) => n === 0), { fanAfter });
  check(`fan-out: the reads hold at most ${HISTORY_READERS} consumers at once`, fanPeak - fanBase <= HISTORY_READERS, { fanPeak, fanBase });

  console.log(`  counts ${JSON.stringify({ cap: CAP, reads: READS, chatBase, chatAfterSingle, chatAfterMulti, dmBase, dmAfter, burst: burst.length, peak, chatAfterBurst, single: single.answered, multi: multi.answered, dms: dms.answered, leftDelivered, leftPage, lost, goneOnBroker, afterLost, leftAfterFirst, leftAfterSecond, fanCap: FANOUT_CAP, fanChannels: FANOUT_CHANNELS, fanAnswered, fanAfter, fanPeakAboveBase: fanPeak - fanBase })}`);
} finally {
  for (const nc of raws) await nc.close().catch(() => {});
  for (const ep of endpoints.reverse()) await ep.stop().catch(() => {});
  for (const r of relays) r.close();
  srv.kill("SIGKILL");
  await wait(200);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
}
finish();
