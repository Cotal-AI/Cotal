/** Native connection custody of a local composition, against a real broker: a delivery lane and an
 *  authority plane that read one workstation root through the filesystem secret store. Their
 *  inventories together equal the data account's complete native census, a message queued for an
 *  offline member is transferred while they serve, and closing them leaves the account with no
 *  connection and a neighbour space untouched. */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { connect, credsAuthenticator, NoRespondersError, RequestError, type NatsConnection } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { encodeUser } from "@nats-io/jwt";
import { fromPublic, fromSeed } from "@nats-io/nkeys";
import {
  CONTROL_DELIVERY, CotalEndpoint, DEV_OWNER, INBOX_READER_DURABLE, composeSpaceAuth, controlServiceSubject, createBrokerAuth,
  createSpaceAccountAuth, credsFromJwt, dlvDurable, dlvStream, inboxStream, isConsumerNotFound, isReachable, mintAccountCensusCreds,
  mintConnectionEvictorCreds, mintCreds, mintLifecycleUid, mintMembershipObserverCreds, newIdentity, observeAccountCensusWithCreds,
  openMembersRegistry, parseSecretStoreIdentity, principalKey, provisionAgentDurables, readMember, serverConfig, setupSpaceStreams,
  type SpaceAuth, type SweptConn,
} from "@cotal-ai/core";
import {
  connectionEvictorCredsKey, deliveryCredsKey, membershipObserverCredsKey, membershipRwCredsKey, userAuthStateDir, workspaceSecretStore,
} from "@cotal-ai/workspace";
import { SMOKE_BROKER_TOKEN, createSuite, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { openAuthAuthorityPlane, type AuthAuthorityPlaneHandle } from "../dist/index.js";
import { openDeliveryLane, type DeliveryLane, type DeliveryNativeConnection } from "../../delivery/src/index.js";
import { pickFreePort } from "./_free-port.js";

const EXPECTED_CELLS = 18;
const { check, finish, passed, failed } = createSuite();
const keepFixture = process.argv.includes("--keep-fixture");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const bytes = (value: string) => new TextEncoder().encode(value);
const until = async (condition: () => boolean | Promise<boolean>, ms = 20_000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await condition()) return true; await wait(100); }
  return false;
};
type Row = { serverId: string; cid: number; label: string };

const port = await pickFreePort();
const servers = `nats://127.0.0.1:${port}`;
const broker = await createBrokerAuth("local-workers-native-connections");
const stamp = Date.now();
const spaces = [`local-a-${stamp}`, `local-b-${stamp}`];
const accounts = await Promise.all(spaces.map((s) => createSpaceAccountAuth(broker, s)));
const auths: SpaceAuth[] = accounts.map((a) => composeSpaceAuth(broker, a));
const brokerDir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const root = join(brokerDir, "workspace");
mkdirSync(root, { mode: 0o700 });
writeFileSync(join(brokerDir, "server.conf"), serverConfig(broker, accounts, { transport: { kind: "plaintext" }, port, storeDir: join(brokerDir, "js") }));
const nats = spawn("nats-server", ["-c", join(brokerDir, "server.conf")], { stdio: "ignore" });
const release = teardownOnSignal(nats, keepFixture ? undefined : brokerDir);
const lanes: DeliveryLane[] = [], planes: AuthAuthorityPlaneHandle[] = [];
const clients: NatsConnection[] = [], endpoints: CotalEndpoint[] = [];
const lines: string[][] = [[], []];
const log = (index: number) => ({ out: (line: string) => { lines[index]!.push(line); }, err: (line: string) => { lines[index]!.push(line); } });

/** Poll until the lane's inventory answers, then return it. */
async function settled(lane: DeliveryLane, timeout = 20_000): Promise<DeliveryNativeConnection[]> {
  const end = Date.now() + timeout;
  let last = "never read";
  while (Date.now() < end) {
    try { return lane.nativeConnections(); } catch (e) { last = (e as Error).message; }
    await wait(25);
  }
  throw new Error(`lane inventory did not settle within ${timeout}ms: ${last}`);
}
const filesNamed = (dir: string, name: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? filesNamed(join(dir, entry.name), name) : entry.name === name ? [join(dir, entry.name)] : []);

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(servers); if (!up) await wait(200); }
  if (!up) throw new Error(`nats-server did not come up on ${port}`);

  // ---- one workstation root, written through the filesystem store ----
  const store = workspaceSecretStore(root), composition = { injected: false as const, root };
  const identity = parseSecretStoreIdentity(store.identity);
  const credFiles: string[] = [];
  for (const [i, space] of spaces.entries()) {
    await setupSpaceStreams({ servers, space, creds: await mintCreds(auths[i]!, newIdentity(), "provisioner") });
    const written: Array<[string, string]> = [
      [deliveryCredsKey(space, composition), await mintCreds(auths[i]!, newIdentity(), "delivery")],
      [membershipRwCredsKey(space, composition), await mintCreds(auths[i]!, newIdentity(), "membership-rw")],
      [membershipObserverCredsKey(space, composition), await mintMembershipObserverCreds(auths[i]!, newIdentity())],
      [connectionEvictorCredsKey(space, composition), await mintConnectionEvictorCreds(auths[i]!, newIdentity())],
    ];
    for (const [key, value] of written) { await store.put(key, value); credFiles.push(join(root, ".cotal", key)); }
  }
  check("the store is the workstation's filesystem store and each space's 4 scoped credentials are private files under the root",
    identity.kind === "fs" && identity.root === root && credFiles.length === 8 && credFiles.every((file) => existsSync(file) && (statSync(file).mode & 0o077) === 0),
    { kind: identity.kind, files: credFiles.map((file) => file.slice(root.length + 1)) });

  // ---- the local composition: a lane and a plane per space, no injected store anywhere ----
  const openLane = (i: number) => openDeliveryLane({ space: spaces[i]!, server: servers, root, rootNamed: true, tls: false, log: log(i) });
  const openPlane = (i: number) => openAuthAuthorityPlane({ server: servers, space: spaces[i]!, dir: userAuthStateDir(root, spaces[i]!), identityRoot: root,
    dataAccount: { pub: accounts[i]!.account.pub, signingSeed: auths[i]!.account.signingSeed }, log: () => {} });
  const laneA = await openLane(0), laneB = await openLane(1); lanes.push(laneA, laneB);
  const planeA = await openPlane(0), planeB = await openPlane(1); planes.push(planeA, planeB);
  const laneRowsA = await settled(laneA), laneRowsB = await settled(laneB);
  const serverId = laneRowsA[0]!.serverId;
  const census = async (index: number): Promise<SweptConn[]> => {
    const result = await observeAccountCensusWithCreds({ servers, observerCreds: await mintAccountCensusCreds(auths[index]!, newIdentity()),
      accountId: accounts[index]!.account.pub, expectedServerId: serverId });
    if (result.state !== "complete") throw new Error(`native census of account ${index} is ${result.state}: ${result.reason}`);
    return result.connections;
  };
  const owned = async (lane: DeliveryLane, plane: AuthAuthorityPlaneHandle): Promise<Row[]> => [...await settled(lane), ...plane.nativeConnections()];
  const sameIds = (rows: Row[], native: SweptConn[]): boolean =>
    rows.length === native.length && new Set(rows.map((row) => row.cid)).size === rows.length
    && rows.every((row) => row.serverId === serverId && native.some((conn) => conn.cid === row.cid && conn.serverId === row.serverId));
  const show = (rows: Row[], native: SweptConn[]) => ({ owned: rows.map((row) => `${row.label}:${row.cid}`), census: native.map((conn) => conn.cid) });
  const labels = (rows: Row[]): string => rows.map((row) => row.label).sort().join(",");

  check("a lane over the root lists one endpoint, one membership-rw and one timer-writer connection",
    labels(laneRowsA) === "endpoint,membership-rw,timer-writer" && labels(laneRowsB) === labels(laneRowsA), { a: labels(laneRowsA), b: labels(laneRowsB) });
  const ownedA = await owned(laneA, planeA), ownedB = await owned(laneB, planeB), nativeA = await census(0), nativeB = await census(1);
  check("account A: the lane's and the plane's connections together are the account's complete native census",
    planeA.nativeConnections().length > 0 && sameIds(ownedA, nativeA), show(ownedA, nativeA));
  check("account B: the lane's and the plane's connections together are the account's complete native census",
    planeB.nativeConnections().length > 0 && sameIds(ownedB, nativeB), show(ownedB, nativeB));
  check("no connection id is reported twice and a lane row carries a label, a server id and a client id, nothing else",
    new Set([...ownedA, ...ownedB].map((row) => row.cid)).size === ownedA.length + ownedB.length
    && [...laneRowsA, ...laneRowsB].every((row) => Object.keys(row).sort().join(",") === "cid,label,serverId"));
  const firstCid = laneRowsA[0]!.cid;
  laneRowsA[0]!.cid = -1;
  check("changing a returned lane row does not change the next read", laneA.nativeConnections()[0]!.cid === firstCid);
  const instanceFiles = filesNamed(join(root, ".cotal"), "auth-instance.json");
  check("each plane keeps its restart identity in a file under the root", instanceFiles.length === 2, instanceFiles.map((file) => file.slice(root.length + 1)));

  // ---- the lane serves: a control request, and a transfer to an offline member's store ----
  const asker = async (i: number): Promise<{ nc: NatsConnection; ask(): Promise<"answered" | "absent"> }> => {
    const id = newIdentity(), uid = mintLifecycleUid();
    const nc = await connect({ servers, authenticator: credsAuthenticator(bytes(await mintCreds(auths[i]!, id, "agent", { lifecycleUid: uid }))), inboxPrefix: `_INBOX_${id.id}` });
    clients.push(nc);
    const subject = controlServiceSubject(spaces[i]!, CONTROL_DELIVERY, DEV_OWNER, id.id);
    return { nc, ask: async () => {
      try {
        await nc.request(subject, JSON.stringify({ op: "listMemberships", args: { lifecycleUid: uid }, from: { id: `${DEV_OWNER}.${id.id}`, name: "lane-probe", kind: "agent" } }),
          { timeout: 1500, noMux: true, reply: `${subject}.reply.${randomUUID()}` });
        return "answered";
      } catch (e) {
        if (e instanceof NoRespondersError || (e instanceof RequestError && e.isNoResponders())) return "absent";
        throw e;
      }
    } };
  };
  /** A fixture reader with the whole data account in reach, for registry and consumer readings. */
  const watcher = async (i: number): Promise<NatsConnection> => {
    const id = newIdentity(), signer = fromSeed(bytes(auths[i]!.account.signingSeed!));
    let jwt: string;
    try { jwt = await encodeUser("fixture-watcher", fromPublic(id.id), fromPublic(accounts[i]!.account.pub), { pub: { allow: [">"] }, sub: { allow: [">"] } },
      { signer, exp: Math.floor(Date.now() / 1000) + 600 }); } finally { signer.clear(); }
    const nc = await connect({ servers, authenticator: credsAuthenticator(bytes(credsFromJwt(jwt, id))), inboxPrefix: `_INBOX_${id.id}`, reconnect: false });
    clients.push(nc);
    return nc;
  };
  const drop = async (nc: NatsConnection) => { await nc.close(); clients.splice(clients.indexOf(nc), 1); };
  const firstAsk = await asker(0);
  check("the lane answers a delivery control request", await firstAsk.ask() === "answered");
  await drop(firstAsk.nc);

  const provisioner = new CotalEndpoint({ space: spaces[0]!, servers, creds: await mintCreds(auths[0]!, newIdentity(), "provisioner"),
    card: { name: "fixture-provisioner", kind: "endpoint" }, channels: [], consume: false, registerPresence: false, watchPresence: false });
  provisioner.on("error", () => {}); endpoints.push(provisioner); await provisioner.start();
  const member = { id: newIdentity(), uid: mintLifecycleUid() }, sender = { id: newIdentity(), uid: mintLifecycleUid() };
  for (const who of [member, sender])
    await provisionAgentDurables(provisioner, { owner: DEV_OWNER, actor: who.id.id, lifecycleUid: who.uid }, { subscribe: ["review"], allowSubscribe: ["review"], allowPublish: ["review"] });
  const got: string[] = [], faults: string[] = [];
  const seat = async (who: typeof member, name: string): Promise<CotalEndpoint> => {
    const endpoint = new CotalEndpoint({ space: spaces[0]!, servers, creds: await mintCreds(auths[0]!, who.id, "agent", { lifecycleUid: who.uid, allowSubscribe: ["review"], allowPublish: ["review"] }), lifecycleUid: who.uid,
      card: { id: who.id.id, name, kind: "agent" }, channels: ["review"], allowSubscribe: ["review"] });
    endpoint.on("error", (error: Error) => faults.push(`${name} error: ${error.message}`));
    endpoint.on("message", (row: unknown, handle: { ack(): void }) => { if (name === "member") got.push(JSON.stringify(row)); handle.ack(); });
    endpoints.push(endpoint); await endpoint.start();
    return endpoint;
  };
  const stop = async (endpoint: CotalEndpoint) => { await endpoint.stop(); endpoints.splice(endpoints.indexOf(endpoint), 1); };
  let memberSeat = await seat(member, "member");
  const senderSeat = await seat(sender, "sender");
  const watch = await watcher(0), jsm = await jetstreamManager(watch);
  const consumer = async (stream: string, name: string) => {
    try { return await jsm.consumers.info(stream, name); } catch (error) { if (isConsumerNotFound(error)) return undefined; throw error; }
  };
  const members = await openMembersRegistry(watch, spaces[0]!);
  const joined = await until(async () => (await readMember(members, "review", principalKey(DEV_OWNER, member.id.id).key, member.uid))?.record.state === "durable-active");
  await senderSeat.multicast("live-through-the-lane", { channel: "review" });
  const memberDurable = dlvDurable(DEV_OWNER, member.id.id, member.uid);
  const readerFloor = async () => (await consumer(inboxStream(spaces[0]!), INBOX_READER_DURABLE))?.ack_floor.consumer_seq ?? -1;
  // The durable copy of the live message passes the reader on its own schedule: wait until the
  // member has taken it, so the store is empty when the member goes offline.
  const taken = await until(async () => {
    const row = await consumer(dlvStream(spaces[0]!), memberDurable);
    return await readerFloor() >= 1 && row !== undefined && row.num_pending === 0 && row.num_ack_pending === 0;
  });
  check("a member joins a channel durably through the lane and receives a channel message while connected",
    joined && taken && got.some((row) => row.includes("live-through-the-lane")), { joined, taken, faults });
  await stop(memberSeat);
  const readerBefore = await readerFloor();
  await senderSeat.multicast("queued-for-the-offline-member", { channel: "review" });
  const queued = await until(async () => (await consumer(dlvStream(spaces[0]!), memberDurable))?.num_pending === 1 && await readerFloor() > readerBefore);
  const readerAfter = await readerFloor();
  check("a message posted while the member is offline passes the lane's inbox reader into the member's delivery store and waits there",
    queued && readerBefore >= 1 && readerAfter === readerBefore + 1,
    { waiting: (await consumer(dlvStream(spaces[0]!), memberDurable))?.num_pending, readerAcknowledgedBefore: readerBefore, readerAcknowledgedAfter: readerAfter });
  await stop(senderSeat);

  // ---- drain observation: the lane's inbox reader holds nothing, then the lane and the plane close ----
  const readings: string[] = [], settleStarted = Date.now();
  const drained = await until(async () => {
    const reader = await consumer(inboxStream(spaces[0]!), INBOX_READER_DURABLE);
    const reading = `pending ${reader?.num_pending} unacknowledged ${reader?.num_ack_pending}`;
    if (readings.at(-1) !== reading) readings.push(reading);
    return reader !== undefined && reader.num_pending === 0 && reader.num_ack_pending === 0;
  }, 120_000);
  console.log(`    inbox reader readings over ${Date.now() - settleStarted} ms: ${readings.join(" | ")}`);
  check("the lane's inbox reader has no pending and no unacknowledged entry before the close", drained, readings);
  await stop(provisioner); await drop(watch);
  const beforeClose = await owned(laneA, planeA), nativeBeforeClose = await census(0), siblingBefore = JSON.stringify(await owned(laneB, planeB));
  check("with the fixture's own clients gone, the lane and the plane again hold the account's complete native census", sameIds(beforeClose, nativeBeforeClose), show(beforeClose, nativeBeforeClose));
  await planeA.close();
  await laneA.close();
  const lost = await Promise.race([laneA.lost, wait(10_000).then(() => "the lane did not settle")]);
  const nativeAfterClose = await census(0);
  check("after the close the lane and the plane report no connection and the account's native census is empty",
    laneA.nativeConnections().length === 0 && planeA.nativeConnections().length === 0 && nativeAfterClose.length === 0,
    { lost, lane: laneA.nativeConnections().length, plane: planeA.nativeConnections().length, census: nativeAfterClose.map((conn) => conn.cid) });
  const lateAsk = await asker(0);
  check("no delivery control responder answers in the closed space", await lateAsk.ask() === "absent");
  await drop(lateAsk.nc);
  const lateWatch = await watcher(0);
  const reader = await jetstreamManager(lateWatch).then((manager) => manager.consumers.info(dlvStream(spaces[0]!), memberDurable)).catch((error: Error) => error.message);
  await drop(lateWatch);
  const neighbourAsk = await asker(1), neighbourAnswer = await neighbourAsk.ask();
  await drop(neighbourAsk.nc);
  const siblingAfter = await owned(laneB, planeB);
  check("the neighbour space keeps the same connections, its complete native census, and its control responder",
    JSON.stringify(siblingAfter) === siblingBefore && sameIds(siblingAfter, await census(1)) && neighbourAnswer === "answered", { neighbourAnswer });

  // ---- the lane reads the root's files: no credential file, no lane; the file back, a new lane ----
  const deliveryFile = credFiles[0]!;
  renameSync(deliveryFile, `${deliveryFile}.aside`);
  const refusal = await openLane(0).then((lane) => { lanes.push(lane); return "opened"; }, (error: Error) => error.message);
  renameSync(`${deliveryFile}.aside`, deliveryFile);
  check("with the delivery credential file moved aside the lane refuses and names the file", refusal.includes(deliveryFile), refusal);
  const again = await openLane(0); lanes.push(again);
  const planeAgain = await openPlane(0); planes.push(planeAgain);
  const reopened = await owned(again, planeAgain), nativeReopened = await census(0);
  check("a lane and a plane reopened from the same root hold new connections that are the account's complete native census",
    sameIds(reopened, nativeReopened) && !reopened.some((row) => beforeClose.some((old) => old.cid === row.cid)), show(reopened, nativeReopened));
  memberSeat = await seat(member, "member");
  check("the message queued before the close is delivered to its member", await until(() => got.some((row) => row.includes("queued-for-the-offline-member"))),
    { waitingAfterClose: typeof reader === "string" ? reader : reader.num_pending, faults });
} catch (error) { check(`harness: ${error instanceof Error ? error.stack : String(error)}`, false); }
finally {
  for (const endpoint of endpoints.reverse()) await endpoint.stop().catch(() => {});
  for (const client of clients.reverse()) await client.close().catch(() => {});
  for (const plane of planes.reverse()) await plane.close().catch((error: Error) => check(`plane cleanup: ${error.message}`, false));
  for (const lane of lanes.reverse()) await lane.close();
  await killAndAwaitExit(nats);
  release();
  if (keepFixture) console.log(`    fixture kept at ${brokerDir}`);
  if (passed() + failed() !== EXPECTED_CELLS) check(`cell count: ran ${passed() + failed()}, expected ${EXPECTED_CELLS}`, false);
  finish();
}
process.exit(process.exitCode ?? 0);
