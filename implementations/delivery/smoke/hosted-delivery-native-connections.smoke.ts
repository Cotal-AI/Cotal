/** Native connection inventory of hosted delivery contexts, against a real broker: every reported
 *  data-account binding equals the account's complete native census, system-account connections
 *  are left out, and a context with no settled answer throws instead of reporting part of one. */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { connect, credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import {
  CotalEndpoint, accountCensusInboxPrefix, composeSpaceAuth, connzRequestSubject, createBrokerAuth, createSpaceAccountAuth,
  eptReqStreamName, identityFromCreds, isReachable, kickConnection, mintAccountCensusCreds, mintConnectionEvictorCreds,
  mintCreds, mintLifecycleUid, mintMembershipObserverCreds, newIdentity, observeAccountCensusWithCreds, serverConfig,
  setupSpaceStreams, type SecretStore, type SpaceAuth, type SweptConn,
} from "@cotal-ai/core";
import { deliveryCredsKey, membershipObserverCredsKey, membershipRwCredsKey } from "@cotal-ai/workspace";
import { SMOKE_BROKER_TOKEN, createSuite, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { startDeliveryService, type DeliveryNativeConnection, type DeliveryServiceHandle } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

const EXPECTED_CELLS = 22;
const { check, finish, passed, failed } = createSuite();
const keepFixture = process.argv.includes("--keep-fixture");

class MemoryStore implements SecretStore {
  readonly values = new Map<string, string>();
  constructor(readonly identity: { kind: "injected"; coordinate: string }) {}
  async get(k: string) { return this.values.get(k); }
  async put(k: string, v: string) { this.values.set(k, v); }
  async create(k: string, v: string) { if (this.values.has(k)) return false; this.values.set(k, v); return true; }
  async delete(k: string) { this.values.delete(k); }
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const bytes = (value: string) => new TextEncoder().encode(value);
const composition = { injected: true as const };
type Label = DeliveryNativeConnection["label"];
const ALL: Label[] = ["endpoint", "membership-rw", "timer-writer"];

const port = await pickFreePort();
const servers = `nats://127.0.0.1:${port}`;
const broker = await createBrokerAuth("delivery-native-connections");
const stamp = Date.now();
// a and b run every part; c has no membership-rw credential, so its feed does not start; d starts
// without the stream its timer writer needs.
const spaces = ["a", "b", "c", "d"].map((name) => `native-${name}-${stamp}`);
const accounts = await Promise.all(spaces.map((s) => createSpaceAccountAuth(broker, s)));
const auths: SpaceAuth[] = accounts.map((a) => composeSpaceAuth(broker, a));
const brokerDir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(brokerDir, "server.conf"), serverConfig(broker, accounts, { transport: { kind: "plaintext" }, port, storeDir: join(brokerDir, "js") }));
const nats = spawn("nats-server", ["-c", join(brokerDir, "server.conf")], { stdio: "ignore" });
const release = teardownOnSignal(nats, keepFixture ? undefined : brokerDir);
const handles: DeliveryServiceHandle[] = [];
const clients: NatsConnection[] = [];
const endpoints: CotalEndpoint[] = [];

/** The inventory as `label:cid` strings, or the reason it threw. */
const read = (handle: DeliveryServiceHandle): { rows: DeliveryNativeConnection[] } | { threw: string } => {
  try { return { rows: handle.nativeConnections() }; } catch (e) { return { threw: (e as Error).message }; }
};
const cidOf = (rows: DeliveryNativeConnection[], label: Label): number | undefined => rows.find((row) => row.label === label)?.cid;
/** Poll until the inventory answers and `accept` holds, then return it. */
async function settled(handle: DeliveryServiceHandle, accept: (rows: DeliveryNativeConnection[]) => boolean = () => true, timeout = 20_000): Promise<DeliveryNativeConnection[]> {
  const end = Date.now() + timeout;
  let last = "never read";
  while (Date.now() < end) {
    const now = read(handle);
    if ("rows" in now) { if (accept(now.rows)) return now.rows; last = JSON.stringify(now.rows); }
    else last = now.threw;
    await wait(25);
  }
  throw new Error(`inventory did not settle within ${timeout}ms: ${last}`);
}
/** Read the inventory once per event-loop turn and keep each distinct consecutive answer. */
function watchInventory(handle: DeliveryServiceHandle): { stop(): Promise<Array<{ rows: DeliveryNativeConnection[] } | { threw: string }>> } {
  const seen: Array<{ rows: DeliveryNativeConnection[] } | { threw: string }> = [];
  let running = true, lastKey = "";
  const loop = (async () => {
    while (running) {
      const now = read(handle), key = JSON.stringify(now);
      if (key !== lastKey) { seen.push(now); lastKey = key; }
      await new Promise((r) => setImmediate(r));
    }
  })();
  return { stop: async () => { running = false; await loop; return seen; } };
}
/** After the first throw, did any answer still name `cid`? */
const namedAfterThrow = (seen: Array<{ rows: DeliveryNativeConnection[] } | { threw: string }>, cid: number): boolean => {
  const first = seen.findIndex((s) => "threw" in s);
  return first >= 0 && seen.slice(first + 1).some((s) => "rows" in s && s.rows.some((row) => row.cid === cid));
};
const threw = (seen: Array<{ rows: DeliveryNativeConnection[] } | { threw: string }>, pattern: RegExp): boolean =>
  seen.some((s) => "threw" in s && pattern.test(s.threw));
const sequence = (seen: Array<{ rows: DeliveryNativeConnection[] } | { threw: string }>): string[] =>
  seen.map((s) => "threw" in s ? `throws: ${s.threw}` : s.rows.map((row) => `${row.label}:${row.cid}`).join(" "));

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(servers); if (!up) await wait(200); }
  if (!up) throw new Error(`nats-server did not come up on ${port}`);
  const stores: MemoryStore[] = [];
  for (const [i, space] of spaces.entries()) {
    await setupSpaceStreams({ servers, space, creds: await mintCreds(auths[i]!, newIdentity(), "provisioner") });
    const store = new MemoryStore({ kind: "injected", coordinate: `memory:${space}` });
    stores.push(store);
    await store.put(deliveryCredsKey(space, composition), await mintCreds(auths[i]!, newIdentity(), "delivery"));
    await store.put(membershipObserverCredsKey(space, composition), await mintMembershipObserverCreds(auths[i]!, newIdentity()));
    if (i !== 2) await store.put(membershipRwCredsKey(space, composition), await mintCreds(auths[i]!, newIdentity(), "membership-rw"));
  }
  const inputs = spaces.map((space, i) => ({
    context: { accountPublicKey: accounts[i]!.account.pub, lifecycleUid: `native-${i}` },
    space, servers, store: stores[i]!, storeIdentity: stores[i]!.identity, stateDir: join(brokerDir, `state-${i}`),
  }));
  const [a, b, c] = await Promise.all(inputs.slice(0, 3).map((input) => startDeliveryService(input)));
  handles.push(a!, b!, c!);
  const rowsA = await settled(a!), rowsB = await settled(b!), rowsC = await settled(c!);
  const serverId = rowsA[0]!.serverId;

  /** The broker's complete native connection list for one data account. */
  const census = async (index: number): Promise<SweptConn[]> => {
    const result = await observeAccountCensusWithCreds({ servers, observerCreds: await mintAccountCensusCreds(auths[index]!, newIdentity()),
      accountId: accounts[index]!.account.pub, expectedServerId: serverId });
    if (result.state !== "complete") throw new Error(`native census of account ${index} is ${result.state}: ${result.reason}`);
    return result.connections;
  };
  const sameIds = (rows: DeliveryNativeConnection[], native: SweptConn[]): boolean =>
    rows.length === native.length && new Set(rows.map((row) => row.cid)).size === rows.length
    && rows.every((row) => row.serverId === serverId && native.some((conn) => conn.cid === row.cid && conn.serverId === row.serverId));
  const labels = (rows: DeliveryNativeConnection[]): string => rows.map((row) => row.label).sort().join(",");
  const show = (rows: DeliveryNativeConnection[], native: SweptConn[]) => ({ inventory: rows.map((row) => `${row.label}:${row.cid}`), census: native.map((conn) => conn.cid) });

  // ---- settled inventories equal the native census ----
  const nativeA = await census(0), nativeB = await census(1), nativeC = await census(2);
  check("a context with every part lists one endpoint, one membership-rw and one timer-writer connection", labels(rowsA) === "endpoint,membership-rw,timer-writer" && labels(rowsB) === labels(rowsA), { a: labels(rowsA), b: labels(rowsB) });
  check("account A: the 3 reported ids are the account's complete native census", nativeA.length === 3 && sameIds(rowsA, nativeA), show(rowsA, nativeA));
  check("account B: the 3 reported ids are the account's complete native census", nativeB.length === 3 && sameIds(rowsB, nativeB), show(rowsB, nativeB));
  check("a context whose membership feed did not start lists 2 connections, the account's complete census", labels(rowsC) === "endpoint,timer-writer" && nativeC.length === 2 && sameIds(rowsC, nativeC), show(rowsC, nativeC));
  const allRows = [...rowsA, ...rowsB, ...rowsC];
  check("no connection id is reported by two contexts", new Set(allRows.map((row) => row.cid)).size === 8, allRows.map((row) => row.cid));
  check("a row carries a label, a server id and a client id, nothing else", allRows.every((row) => Object.keys(row).sort().join(",") === "cid,label,serverId"));
  const firstCid = rowsA[0]!.cid;
  rowsA[0]!.cid = -1; rowsA[0]!.label = "timer-writer";
  check("changing a returned row does not change the next read", JSON.stringify(a!.nativeConnections()[0]) === JSON.stringify({ label: "endpoint", serverId, cid: firstCid }));

  // ---- system-account connections are not listed ----
  // The census helper names no connection, so the system account is read with the same scoped
  // credential shape and the raw reply's names pick out the membership observers.
  const sysPub = auths[0]!.sys.pub, sysPrefix = accountCensusInboxPrefix(sysPub);
  const sysReader = await connect({ servers, authenticator: credsAuthenticator(bytes(await mintAccountCensusCreds({ account: { pub: sysPub }, sys: auths[0]!.sys }, newIdentity()))), inboxPrefix: sysPrefix, reconnect: false });
  clients.push(sysReader);
  const sysReply = await sysReader.request(connzRequestSubject(sysPub), JSON.stringify({ subscriptions: false, limit: 1024 }), { timeout: 2000, noMux: true, reply: `${sysPrefix}.${randomUUID()}` });
  const sysConns = sysReply.json<{ data?: { total?: number; connections?: Array<{ cid?: number; name?: string }> } }>().data;
  const observers = (sysConns?.connections ?? []).filter((conn) => conn.name === "cotal-membership-observer");
  check("the broker holds 2 membership observers in the system account and no inventory lists either",
    sysConns?.total === sysConns?.connections?.length && observers.length === 2 && observers.every((conn) => typeof conn.cid === "number" && !allRows.some((row) => row.cid === conn.cid)),
    { total: sysConns?.total, names: sysConns?.connections?.map((conn) => conn.name) });

  // ---- a context without its timer writer has no settled answer ----
  {
    const tid = newIdentity();
    const teardown = await connect({ servers, authenticator: credsAuthenticator(bytes(await mintCreds(auths[3]!, tid, "teardown", { lifecycleUid: mintLifecycleUid() }))), inboxPrefix: `_INBOX_${tid.id}` });
    await (await jetstreamManager(teardown)).streams.delete(eptReqStreamName(spaces[3]!));
    await teardown.close();
  }
  const d = await startDeliveryService(inputs[3]!);
  handles.push(d);
  await wait(1_000); // the writer's start has refused and its loop is in the first backoff
  const absent = read(d), nativeDBefore = await census(3);
  check("a context whose timer writer is not connected throws while the broker shows its 2 other connections",
    "threw" in absent && /timer writer is not connected/.test(absent.threw) && nativeDBefore.length === 2, { absent, census: nativeDBefore.map((conn) => conn.cid) });
  await setupSpaceStreams({ servers, space: spaces[3]!, creds: await mintCreds(auths[3]!, newIdentity(), "provisioner") });
  const rowsD = await settled(d);
  const nativeD = await census(3);
  check("once its stream is back the same context lists 3 connections, the account's complete census", labels(rowsD) === "endpoint,membership-rw,timer-writer" && sameIds(rowsD, nativeD), show(rowsD, nativeD));

  // ---- a broker-side drop of each connection ----
  const evictorId = newIdentity();
  const evictor = await connect({ servers, authenticator: credsAuthenticator(bytes(await mintConnectionEvictorCreds(auths[1]!, evictorId))), reconnect: false });
  clients.push(evictor);
  for (const label of ALL) {
    const before = await settled(b!);
    const old = cidOf(before, label)!;
    const watch = watchInventory(b!);
    await kickConnection(evictor, { serverId, cid: old });
    let after: DeliveryNativeConnection[] | undefined, fault = "";
    try { after = await settled(b!, (rows) => cidOf(rows, label) !== old); } catch (e) { fault = (e as Error).message; }
    const seen = await watch.stop();
    const native = await census(1);
    check(`a kicked ${label} connection: the inventory throws while it redials, never names the old id afterwards, then equals the census again`,
      after !== undefined && threw(seen, /unsettled|not connected|no settled native binding/) && !namedAfterThrow(seen, old)
      && labels(after) === "endpoint,membership-rw,timer-writer" && sameIds(after, native) && !native.some((conn) => conn.cid === old),
      { fault, old, seen: sequence(seen), census: native.map((conn) => conn.cid) });
    console.log(`    observed (${label} kicked): ${sequence(seen).join(" | ")}`);
  }

  // ---- a credential adoption ----
  const beforeAdoption = await settled(b!);
  const supId = newIdentity();
  const sup = new CotalEndpoint({
    space: spaces[1]!, servers, creds: await mintCreds(auths[1]!, supId, "supervisor"),
    card: { id: supId.id, name: "renewal-owner", kind: "endpoint" },
    consume: false, watchChannels: false, watchPresence: false, registerPresence: false,
  });
  sup.on("error", () => {});
  endpoints.push(sup);
  await sup.start();
  const supCid = sup.nativeConnections()[0]!.cid;
  const withSup = await census(1);
  check("a data-account connection the context does not hold is in the census and not in the inventory",
    withSup.length === 4 && withSup.some((conn) => conn.cid === supCid) && !beforeAdoption.some((row) => row.cid === supCid) && !sameIds(beforeAdoption, withSup),
    { supCid, ...show(beforeAdoption, withSup) });
  // A credential signed in a later second than the one in use, for the same identities.
  const second = Math.floor(Date.now() / 1000);
  while (Math.floor(Date.now() / 1000) <= second) await wait(20);
  for (const [key, profile] of [[deliveryCredsKey(spaces[1]!, composition), "delivery"], [membershipRwCredsKey(spaces[1]!, composition), "membership-rw"]] as const)
    await stores[1]!.put(key, await mintCreds(auths[1]!, identityFromCreds((await stores[1]!.get(key))!), profile));
  const adoptionWatch = watchInventory(b!);
  let adopted = await sup.requestDeliveryAdmin("reloadCreds", {}, 15_000);
  for (let i = 0; i < 25 && !adopted.ok && (adopted.error ?? "").includes("has not finished starting"); i++) {
    await wait(200);
    adopted = await sup.requestDeliveryAdmin("reloadCreds", {}, 15_000);
  }
  let afterAdoption: DeliveryNativeConnection[] | undefined, adoptionFault = "";
  try { afterAdoption = await settled(b!, (rows) => ALL.every((label) => cidOf(rows, label) !== cidOf(beforeAdoption, label))); } catch (e) { adoptionFault = (e as Error).message; }
  const adoptionSeen = await adoptionWatch.stop();
  await sup.stop();
  endpoints.splice(endpoints.indexOf(sup), 1);
  check("the delivery admin rail adopts the re-signed credentials", adopted.ok === true, adopted);
  check("the inventory throws during the adoption and never names a replaced id afterwards",
    threw(adoptionSeen, /credential|unsettled|not connected|no settled native binding/) && afterAdoption !== undefined
    && beforeAdoption.every((row) => !afterAdoption!.some((now) => now.cid === row.cid)),
    { adoptionFault, seen: sequence(adoptionSeen) });
  console.log(`    observed (adoption): ${sequence(adoptionSeen).join(" | ")}`);
  let nativeAfterAdoption: SweptConn[] = [];
  for (let i = 0; i < 40; i++) { nativeAfterAdoption = await census(1); if (nativeAfterAdoption.length === 3) break; await wait(100); }
  check("after the adoption the 3 new ids are the account's complete native census", afterAdoption !== undefined && sameIds(await settled(b!), nativeAfterAdoption),
    { census: nativeAfterAdoption.map((conn) => conn.cid), inventory: read(b!) });

  // ---- close, and the sibling accounts ----
  const siblingBefore = JSON.stringify(await settled(b!));
  const closing = a!.close();
  const duringClose = read(a!);
  await closing;
  handles.splice(handles.indexOf(a!), 1);
  check("a read during a close throws", "threw" in duringClose && /closing/.test(duringClose.threw), duringClose);
  const closedRows = read(a!), nativeAClosed = await census(0);
  check("a closed context reports no connection and its account's native census is empty", "rows" in closedRows && closedRows.rows.length === 0 && nativeAClosed.length === 0, { closedRows, census: nativeAClosed.map((conn) => conn.cid) });
  check("closing one context leaves another account's inventory and census unchanged", JSON.stringify(await settled(b!)) === siblingBefore && sameIds(await settled(b!), await census(1)));

  // ---- a context that lost its lease ----
  const insId = newIdentity();
  const inspector = new CotalEndpoint({
    space: spaces[2]!, servers, creds: await mintCreds(auths[2]!, insId, "delivery"), card: { id: insId.id, name: "inspector", kind: "endpoint" },
    channels: [], consume: false, watchChannels: false, watchPresence: false, registerPresence: false,
  });
  inspector.on("error", () => {});
  endpoints.push(inspector);
  await inspector.start();
  const inspectorCid = inspector.nativeConnections()[0]!.cid;
  const held = await inspector.readDeliveryLeaseEntry(0);
  if (held === undefined) throw new Error("account C's delivery lease is not readable");
  await inspector.markDeliveryLeaseNotReady(0, held.revision);
  let nativeCFenced: SweptConn[] = [];
  for (let i = 0; i < 100; i++) {
    nativeCFenced = await census(2);
    if ((await c!.readiness()).state === "unavailable" && nativeCFenced.length === 1) break;
    await wait(100);
  }
  const fenced = read(c!);
  check("a context that stopped without releasing its lease throws instead of reporting none, while the broker shows its connections gone",
    (await c!.readiness()).state === "unavailable" && "threw" in fenced && /close did not succeed/.test(fenced.threw) && nativeCFenced.length === 1 && nativeCFenced[0]!.cid === inspectorCid,
    { fenced, census: nativeCFenced.map((conn) => conn.cid), inspectorCid });
  const taken = await inspector.readDeliveryLeaseEntry(0);
  await inspector.releaseDeliveryLease(0, taken?.revision);
  await inspector.stop();
  endpoints.splice(endpoints.indexOf(inspector), 1);
  await c!.close().catch(() => {});
  handles.splice(handles.indexOf(c!), 1);
  check("the other contexts still equal their native census", sameIds(await settled(b!), await census(1)) && sameIds(await settled(d), await census(3)));
} catch (error) { check(`harness: ${error instanceof Error ? error.stack : String(error)}`, false); }
finally {
  for (const handle of handles.reverse()) {
    try { await handle.close(); } catch (error) { check(`context cleanup: ${String(error)}`, false); }
  }
  for (const ep of endpoints) { try { await ep.stop(); } catch { /* broker may be gone */ } }
  for (const nc of clients) await nc.close();
  await killAndAwaitExit(nats, "SIGKILL");
  nats.unref();
  if (keepFixture) console.log(`retained fixture: ${brokerDir}`);
  else if (existsSync(brokerDir)) rmSync(brokerDir, { recursive: true, force: true });
  release();
  if (passed() + failed() !== EXPECTED_CELLS) check(`cell count: ran ${passed() + failed()}, expected ${EXPECTED_CELLS}`, false);
  finish();
}
process.exit(process.exitCode ?? 0);
