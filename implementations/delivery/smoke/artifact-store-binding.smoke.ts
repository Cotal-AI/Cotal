/**
 * The artifact store binding and the store contract behind the `artifacts` endpoint (A2), against a
 * real nats-server with real minted credentials and the real delivery daemon.
 *
 * Every hosted context here enters through `../src/delivery.js`, never the package index, so the
 * default store this suite finds is the one the daemon module registers itself (E6).
 *
 *  1. (BRIEF item 6) a space bound to a store nobody registered refuses at start, by name, and the
 *     broker's cumulative connection counter does not move: not even the unnamed reachability probe
 *     dialed (E5a);
 *  2. the same material bound to `jetstream` starts, moves that counter before any bootstrap, logs the
 *     store it took and binds `artifacts`: the control for cell 1's observer;
 *  3. with no binding the daemon starts on the default and says so;
 *  4. a binding that is not a store name (spaces, a trailing newline, 65 characters) refuses before any
 *     dial without echoing the value, and so does a registered store that declares a bad block size;
 *  5. fetch-chunk from offset 70,001 answers A1's own reply sequence, pinned from the real A1 handler
 *     at bc5f3505a1 (RUNS.md), at the broker's limit and after a restart at max_payload 70,000, with
 *     the received bytes equal to the fixture's suffix; on a second artifact, a stored chunk purged
 *     mid-fetch turns the next reply into `artifact expired` at the pinned offset;
 *  6. the jetstream store's ranged read answers any range inside the artifact (inside one block,
 *     across a boundary, to the end, one aligned block), undefined when a touched block is gone, and
 *     refuses a range past the artifact (E7, S4);
 *  7. census: only the store module names the object stream, only the daemon module imports it, the
 *     default name is written once, the registry is resolved for the kind in one place, no served
 *     endpoint table holds a factory, and the core contract imports no NATS module.
 *
 * Needs nats-server on PATH. Run: pnpm smoke:artifact-store-binding
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { connect, credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import {
  ARTIFACT_STORE_KIND, ARTIFACTS_CAPABILITY, ARTIFACTS_ENDPOINT, ARTIFACTS_FETCH_CHUNK_COMMAND, artifactBucket, composeSpaceAuth,
  confirmAttach, CotalEndpoint, createBrokerAuth, createSpaceAccountAuth, DEV_OWNER, idFromCreds, isReachable,
  mintConnectionEvictorCreds, mintCreds, mintLifecycleUid, mintMembershipObserverCreds, newIdentity, objectStoreStream,
  provisionAgentDurables, putArtifact, registry, serverConfig, setupSpaceStreams, type ArtifactStore, type SecretStore,
} from "@cotal-ai/core";
import {
  ARTIFACT_DATA_CREDS_KIND, ARTIFACT_STORE_BINDING_KIND, ARTIFACT_SWEEPER_CREDS_KIND, DAEMON_ENDPOINT_BOOTSTRAPS,
  bootstrapDaemonEndpoint, connectionEvictorCredsKey, daemonEndpointKey, deliveryCredsKey, membershipObserverCredsKey,
  membershipRwCredsKey,
} from "@cotal-ai/workspace";
import { SMOKE_BROKER_TOKEN, createSuite, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { startDeliveryService, type DeliveryServiceHandle } from "../src/delivery.js";
import { ArtifactObjects } from "../src/stores/jetstream-store.js";
import { pickFreePort } from "./_free-port.js";

const EXPECTED_CELLS = 13;
const { check, finish, passed, failed } = createSuite();

class MemoryStore implements SecretStore {
  readonly values = new Map<string, string>();
  constructor(readonly identity: { kind: "injected"; coordinate: string }) {}
  async get(k: string) { return this.values.get(k); }
  async put(k: string, v: string) { this.values.set(k, v); }
  async create(k: string, v: string) { if (this.values.has(k)) return false; this.values.set(k, v); return true; }
  async delete(k: string) { this.values.delete(k); }
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dial = async (servers: string, creds: string): Promise<NatsConnection> =>
  connect({ servers, authenticator: credsAuthenticator(new TextEncoder().encode(creds)), inboxPrefix: `_INBOX_${idFromCreds(creds)}`, reconnect: false });

/** The fetch fixture and the replies A1's real handler gave for it at bc5f3505a1 (RUNS.md). */
const SIZE = 200_000, FROM = 70_001, LOW = 70_000;
const fixture = (a: number, b: number) => new Uint8Array(SIZE).map((_, i) => (i * a + b) % 251);
type Step = [offset: number, length: number, complete: boolean] | [offset: number, refusal: string];
const A1_WIDE: Step[] = [[70001, 129999, true]];
const A1_NARROW: Step[] = [[70001, 52428, false], [122429, 8643, false], [131072, 52428, false], [183500, 16500, true]];
const A1_MISSING: Step[] = [[70001, 52428, false], [122429, "not-found: fetch-chunk: artifact expired"]];

const port = await pickFreePort(), monitorPort = await pickFreePort();
const servers = `nats://127.0.0.1:${port}`;
const broker = await createBrokerAuth("artifact-store-binding");
const space = `artbind-${Date.now()}`;
const account = await createSpaceAccountAuth(broker, space);
const auth = composeSpaceAuth(broker, account);
const brokerDir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const confPath = join(brokerDir, "server.conf");
const conf = (maxPayload?: number) =>
  serverConfig(broker, [account], { transport: { kind: "plaintext" }, port, storeDir: join(brokerDir, "js"), ...(maxPayload !== undefined ? { maxPayload } : {}) })
  + `\nhttp: 127.0.0.1:${monitorPort}\n`;
writeFileSync(confPath, conf());
let nats = spawn("nats-server", ["-c", confPath], { stdio: "ignore" });
let release = teardownOnSignal(nats, brokerDir);
const handles: DeliveryServiceHandle[] = [];
const endpoints: CotalEndpoint[] = [];
const conns: NatsConnection[] = [];
/** Cumulative client connections the broker has accepted. HTTP monitoring opens none. */
const totalConnections = async (): Promise<number> =>
  ((await (await fetch(`http://127.0.0.1:${monitorPort}/varz`)).json()) as { total_connections: number }).total_connections;
/** Every line the daemon logs while `run` starts it. */
const captured = async <T>(run: () => Promise<T>): Promise<{ result?: T; error?: string; lines: string[] }> => {
  const lines: string[] = [];
  const original = { log: console.log, error: console.error };
  console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
  console.error = (...a: unknown[]) => { lines.push(a.join(" ")); };
  try { return { result: await run(), lines }; }
  catch (e) { return { error: (e as Error).message, lines }; }
  finally { console.log = original.log; console.error = original.error; }
};

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(servers); if (!up) await wait(200); }
  if (!up) throw new Error(`nats-server did not come up on ${port}`);
  const provisionerId = newIdentity();
  const provisioner = await mintCreds(auth, provisionerId, "provisioner");
  await setupSpaceStreams({ servers, space, creds: provisioner });
  const provisionerEp = new CotalEndpoint({ space, servers, creds: provisioner, channels: [], consume: false, registerPresence: false, watchPresence: false,
    card: { id: provisionerId.id, name: "provisioner", role: "provisioner", kind: "agent" } });
  provisionerEp.on("error", () => {});
  endpoints.push(provisionerEp);
  await provisionerEp.start();

  /** One hosted context's injected store, holding the material its issuer would write. */
  const material = async (binding?: string): Promise<MemoryStore> => {
    const store = new MemoryStore({ kind: "injected", coordinate: `memory:${space}:${mintLifecycleUid()}` });
    const composition = { injected: true as const };
    await store.put(deliveryCredsKey(space, composition), await mintCreds(auth, newIdentity(), "delivery"));
    await store.put(membershipObserverCredsKey(space, composition), await mintMembershipObserverCreds(auth, newIdentity()));
    await store.put(membershipRwCredsKey(space, composition), await mintCreds(auth, newIdentity(), "membership-rw"));
    await store.put(connectionEvictorCredsKey(space, composition), await mintConnectionEvictorCreds(auth, newIdentity()));
    if (binding !== undefined) await store.put(daemonEndpointKey(space, ARTIFACTS_ENDPOINT, ARTIFACT_STORE_BINDING_KIND), binding);
    return store;
  };
  const start = (store: MemoryStore, tag: string) => startDeliveryService({
    context: { accountPublicKey: account.account.pub, lifecycleUid: `artbind-${tag}` },
    space, servers, store, storeIdentity: store.identity, stateDir: join(brokerDir, `state-${tag}`), endpoints: [ARTIFACTS_ENDPOINT],
  });
  /** A start that must refuse before it dials: the refusal, and whether the counter stayed put. */
  const refusedBeforeDial = async (store: MemoryStore, tag: string) => {
    const before = await totalConnections();
    const run = await captured(() => start(store, tag));
    if (run.result) handles.push(run.result);
    await wait(300);
    return { error: run.error ?? "(started)", moved: (await totalConnections()) - before, lines: run.lines };
  };

  // ---- 1. an unregistered store refuses at start, before any dial ----
  const nowhere = await refusedBeforeDial(await material("nowhere"), "nowhere");
  check("a space bound to an unregistered store refuses at start by name, and the broker accepted no connection for it",
    nowhere.error === `delivery: no artifact store "nowhere" is registered; nothing was started` && nowhere.moved === 0, nowhere);

  // ---- 3. no binding: the default. Run and closed before the bound daemon, so one daemon at a
  //      time holds the space's shard lease ----
  const omittedStore = await material();
  const omitted = await captured(() => start(omittedStore, "omitted"));
  check("with no binding the daemon starts on the default store and says so",
    omitted.result !== undefined && omitted.lines.some((l) => l.includes(`${ARTIFACTS_ENDPOINT}: artifact store "jetstream" (no binding: the default)`)),
    { error: omitted.error, lines: omitted.lines.filter((l) => l.includes("artifact store")) });
  await omitted.result?.close();

  // ---- 4. a malformed binding, and a store with a bad block size ----
  const notName = `delivery: the artifact store binding for space "${space}" is not a store name; nothing was started`;
  const malformed = [];
  for (const [i, value] of ["No Store", "jetstream\n", "a".repeat(65)].entries()) malformed.push(await refusedBeforeDial(await material(value), `bad${i}`));
  check("a binding that is not a store name refuses before any dial, without echoing the value",
    malformed.every((m) => m.error === notName && m.moved === 0), malformed.map(({ error, moved }) => ({ error, moved })));
  const broken: ArtifactStore = { kind: ARTIFACT_STORE_KIND, name: "zero-block", blockBytes: 0, open: () => { throw new Error("never opened"); } };
  registry.register(broken);
  const zero = await refusedBeforeDial(await material("zero-block"), "zero");
  registry.unregister(ARTIFACT_STORE_KIND, "zero-block");
  check("a registered store that declares an invalid block size refuses at start, before any dial",
    zero.error === `delivery: artifact store "zero-block" declares an invalid block size; nothing was started` && zero.moved === 0, zero);

  // ---- 2. the same material as cell 1, bound to jetstream: the control for cell 1's observer ----
  const boundStore = await material("jetstream");
  const beforeBound = await totalConnections();
  const bound = await captured(() => start(boundStore, "bound"));
  if (bound.result) handles.push(bound.result);
  const movedBeforeBootstrap = (await totalConnections()) - beforeBound;
  check("the same material bound to jetstream starts and the same observer sees it dial, before any bootstrap",
    bound.result !== undefined && movedBeforeBootstrap > 0, { error: bound.error, movedBeforeBootstrap });
  check("the daemon logs the store it took, as bound for this space",
    bound.lines.some((l) => l.includes(`${ARTIFACTS_ENDPOINT}: artifact store "jetstream" (bound for this space)`)), bound.lines.filter((l) => l.includes("artifact store")));
  const boundState = await bootstrapDaemonEndpoint({ auth, servers, space, store: boundStore, log: () => {} }, DAEMON_ENDPOINT_BOOTSTRAPS[ARTIFACTS_ENDPOINT]!());
  check("the bound daemon binds artifacts", Number.isSafeInteger(boundState.epoch) && boundState.epoch >= 0 && boundState.instanceId.length > 0, boundState);

  // ---- 5. A1's reply boundaries, from the real handler ----
  const channel = "work.files";
  const uid = mintLifecycleUid(), principal = { owner: DEV_OWNER, actor: "alice" };
  await provisionAgentDurables(provisionerEp, { ...principal, lifecycleUid: uid }, { subscribe: [], allowSubscribe: [channel] });
  const aliceId = newIdentity();
  const aliceCreds = await mintCreds(auth, aliceId, "agent", { principal, lifecycleUid: uid, allowSubscribe: [channel], allowPublish: [channel], capabilities: [ARTIFACTS_CAPABILITY] });
  const alice = new CotalEndpoint({ space, servers, creds: aliceCreds, lifecycleUid: uid, channels: [], allowSubscribe: [channel], watchChannels: false, watchPresence: false, registerPresence: false,
    card: { id: aliceId.id, owner: DEV_OWNER, actor: "alice", name: "alice", kind: "agent" } });
  alice.on("error", () => {});
  endpoints.push(alice);
  await alice.start();
  const attach = async (bytes: Uint8Array, name: string) => {
    const d = (await putArtifact(alice, bytes, { name, mediaType: "application/octet-stream" })).digest;
    const posted = await alice.multicastWithAck(name, { channel, parts: [{ kind: "artifact", name, mediaType: "application/octet-stream", digest: d, size: bytes.byteLength }] });
    await confirmAttach(alice, { digest: d, channel, seq: posted.seq });
    return d;
  };
  const one = fixture(31, 7), two = fixture(17, 3);
  const d1 = await attach(one, "one.bin"), d2 = await attach(two, "two.bin");
  /** fetch-chunk from FROM until complete or refused; `between` runs after the first reply. */
  const walk = async (d: string, between?: () => Promise<void>): Promise<{ steps: Step[]; bytes: Buffer }> => {
    const steps: Step[] = [], parts: Buffer[] = [];
    let offset = FROM;
    for (let n = 0; n < 64; n++) {
      const r = await alice.invokeService(ARTIFACTS_ENDPOINT, ARTIFACTS_FETCH_CHUNK_COMMAND, { digest: d, channel, offset });
      if (!r.reply.ok) { steps.push([offset, `${r.reply.error.code}: ${r.reply.error.message}`]); break; }
      const data = Buffer.from((r.reply.data as { data: string }).data, "base64"), complete = (r.reply.data as { complete: boolean }).complete;
      steps.push([offset, data.byteLength, complete]);
      parts.push(data);
      offset += data.byteLength;
      if (complete) break;
      if (n === 0 && between) await between();
    }
    return { steps, bytes: Buffer.concat(parts) };
  };
  /** The replies cover FROM..SIZE with no gap or overlap and end complete. */
  const covers = (steps: Step[]) => steps.every((s, i) => typeof s[1] === "number" && s[0] === (i === 0 ? FROM : (steps[i - 1]![0] + (steps[i - 1]![1] as number))))
    && steps.at(-1)![2] === true && steps.at(-1)![0] + (steps.at(-1)![1] as number) === SIZE;
  const suffix = (src: Uint8Array) => Buffer.from(src.subarray(FROM));
  const wide = await walk(d1);
  check("at the broker's limit, fetch-chunk from 70,001 gives A1's reply sequence, and the bytes are the fixture's suffix",
    JSON.stringify(wide.steps) === JSON.stringify(A1_WIDE) && covers(wide.steps) && wide.bytes.equals(suffix(one)), wide.steps);
  await release();
  await new Promise((r) => nats.once("exit", r));
  writeFileSync(confPath, conf(LOW));
  nats = spawn("nats-server", ["-c", confPath], { stdio: "ignore" });
  release = teardownOnSignal(nats, brokerDir);
  let back = false;
  for (let i = 0; i < 150 && !back; i++) { await wait(200); try { back = alice.maxPayload === LOW; } catch { /* reconnecting */ } }
  await wait(2_000);
  const narrow = await walk(d1);
  const prefixes = narrow.steps.filter((s) => typeof s[1] === "number" && s[1] < Math.min(65_536 - (s[0] % 65_536), SIZE - s[0]));
  check("at max_payload 70,000 the replies are A1's, at least one is a measured prefix, and the bytes are the fixture's suffix",
    back && JSON.stringify(narrow.steps) === JSON.stringify(A1_NARROW) && prefixes.length > 0 && covers(narrow.steps) && narrow.bytes.equals(suffix(one)),
    { back, steps: narrow.steps, prefixes });
  const sweeperCreds = (await boundStore.get(daemonEndpointKey(space, ARTIFACTS_ENDPOINT, ARTIFACT_SWEEPER_CREDS_KIND)))!;
  const sweeper = await dial(servers, sweeperCreds);
  conns.push(sweeper);
  const jsm = await jetstreamManager(sweeper, { checkAPI: false });
  const missing = await walk(d2, async () => {
    await jsm.streams.purge(objectStoreStream(artifactBucket(space)), { filter: `$O.${artifactBucket(space)}.C.${d2.slice(7)}.2` });
  });
  check("on a second artifact, a stored chunk purged mid-fetch makes the next reply artifact expired at A1's offset",
    JSON.stringify(missing.steps) === JSON.stringify(A1_MISSING), missing.steps);

  // ---- 6. the jetstream store's ranged read, called directly ----
  const data = await dial(servers, (await boundStore.get(daemonEndpointKey(space, ARTIFACTS_ENDPOINT, ARTIFACT_DATA_CREDS_KIND)))!);
  conns.push(data);
  const objects = new ArtifactObjects(data, space, sweeper);
  const same = async (offset: number, length: number) => Buffer.from((await objects.read(d1, offset, length)) ?? []).equals(Buffer.from(one.subarray(offset, offset + length)));
  const ranges = { inside: await same(100, 100), across: await same(65_000, 1_000), toEnd: await same(FROM, SIZE - FROM), aligned: await same(131_072, 65_536) };
  check("the store's ranged read answers inside a block, across a block boundary, to the end, and one aligned block, byte for byte",
    Object.values(ranges).every(Boolean), ranges);
  const gone = await objects.read(d2, 131_000, 1_000), still = Buffer.from((await objects.read(d2, 70_000, 100)) ?? []).equals(Buffer.from(two.subarray(70_000, 70_100)));
  let past = "";
  try { await objects.read(d1, SIZE - 10, 20); past = "read"; } catch (e) { past = (e as Error).message; }
  check("a range touching a purged block reads as gone, a range beside it still answers, and a range past the artifact refuses",
    gone === undefined && still && /the range is past the artifact/.test(past), { gone: gone?.byteLength, still, past });

  // ---- 7. census ----
  const src = resolve(import.meta.dirname, "../src");
  const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : []; });
  const rel = (p: string) => relative(src, p);
  const text = Object.fromEntries(files(src).map((p) => [rel(p), readFileSync(p, "utf8")]));
  const where = (re: RegExp) => Object.entries(text).filter(([, t]) => re.test(t)).map(([f]) => f).sort();
  const census = {
    objectStream: where(/\$O\.|objectStoreStream/),
    storeImporters: where(/from "\.\/stores\/jetstream-store\.js"|import "\.\/stores\/jetstream-store\.js"/),
    nameImporters: where(/jetstream-name\.js"/),
    defaultLiteral: where(/"jetstream"/),
    kindResolvers: where(/registry\.resolve<ArtifactStore>\(ARTIFACT_STORE_KIND/),
    factoryTable: where(/SERVED_ENDPOINT_CATALOG|:\s*artifactsServedEndpoint\b/),
    coreNats: /@nats-io\//.test(readFileSync(resolve(import.meta.dirname, "../../../packages/core/src/artifact-store.ts"), "utf8")),
  };
  check("census: only the store names the object stream, only the daemon module imports it, the default is written once, one resolver, no factory table, and the core contract imports no NATS module",
    JSON.stringify(census.objectStream) === JSON.stringify(["stores/jetstream-store.ts"])
      && JSON.stringify(census.storeImporters) === JSON.stringify(["delivery.ts"])
      && JSON.stringify(census.nameImporters) === JSON.stringify(["served-endpoints.ts", "stores/jetstream-store.ts"])
      && JSON.stringify(census.defaultLiteral) === JSON.stringify(["stores/jetstream-name.ts"])
      && JSON.stringify(census.kindResolvers) === JSON.stringify(["served-endpoints.ts"])
      && census.factoryTable.length === 0 && census.coreNats === false,
    census);
} catch (e) {
  check("the cell ran to completion", false, (e as Error).stack ?? String(e));
} finally {
  for (const ep of endpoints) await ep.stop().catch(() => {});
  for (const nc of conns) await nc.close().catch(() => {});
  for (const h of handles) await h.close().catch(() => {});
  await release();
}
finish();
if (passed() + failed() !== EXPECTED_CELLS) {
  console.error(`expected ${EXPECTED_CELLS} cells, ran ${passed() + failed()}`);
  process.exitCode = 1;
}
