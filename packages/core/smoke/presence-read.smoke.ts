/**
 * THE ON-DEMAND ROSTER READ (SPEC §6): a member that does not watch presence reads it when it acts.
 *
 * Auth mode, the hosted shape: two seats provisioned and credentialed as the manager provisions them,
 * neither watching. A read returns both live, binds no consumer on the presence stream, shows a
 * gracefully stopped peer offline, and keeps that peer as offline after its key has left the bucket.
 * A credential without the Direct Get grant (the supervisor profile, which registers presence and may
 * only watch it) is refused with the grant named, and a watching endpoint refuses the call.
 *
 * Open mode: a bucket of 1,100 records reads complete (a single `multi_last` request refuses more
 * than 1,024), a mis-keyed record is dropped and counted as the watch drops it, and a record whose
 * `ts` is past the liveness window reads offline.
 *
 * Needs nats-server on PATH.
 * Run: pnpm smoke:presence-read
 */
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { Kvm, type KV } from "@nats-io/kv";
import {
  CotalEndpoint, composeSpaceAuth, createBrokerAuth, createSpaceAccountAuth, isReachable, mintCreds,
  lastKvEntries, mintLifecycleUid, newIdentity, presenceBucket, provisionAgent, serverConfig,
  setupSpaceStreams, type Presence,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";

let cells = 0;
let failed = 0;
const check = (name: string, condition: boolean, detail?: unknown): void => {
  cells++;
  if (condition) return console.log(`  ✓ ${name}`);
  failed++;
  console.log(`  x FAIL  ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const HEARTBEAT_MS = 200;
const TTL_MS = 1_200;
const byName = (roster: Presence[], name: string) => roster.find((p) => p.card.name === name);

async function brokerUp(servers: string, proc: ChildProcess): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (proc.exitCode !== null) break;
    if (await isReachable(servers)) return;
    await wait(50);
  }
  throw new Error(`fixture broker never came up on ${servers} - refusing to report on a server that never started`);
}

const dirs: string[] = [];
const brokers: ChildProcess[] = [];
const releases: Array<() => void> = [];
const endpoints: CotalEndpoint[] = [];
try {
  // ---- auth mode -----------------------------------------------------------------------------------
  {
    const port = await pickFreePort();
    const servers = `nats://127.0.0.1:${port}`;
    const tag = randomUUID().slice(0, 6);
    const space = `presence-read-${tag}`;
    const brokerAuth = await createBrokerAuth(`presence-read-${tag}`);
    const account = await createSpaceAccountAuth(brokerAuth, space);
    const auth = composeSpaceAuth(brokerAuth, account);
    const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
    dirs.push(dir);
    const monPort = await pickFreePort();
    writeFileSync(join(dir, "server.conf"), serverConfig(brokerAuth, [account], { transport: { kind: "plaintext" }, port, storeDir: join(dir, "js") }) + `\nhttp: 127.0.0.1:${monPort}\n`);
    const broker = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
    brokers.push(broker);
    releases.push(teardownOnSignal(broker, dir));
    await brokerUp(servers, broker);

    const provCreds = await mintCreds(auth, newIdentity(), "provisioner");
    await setupSpaceStreams({ servers, space, creds: provCreds });
    const prov = new CotalEndpoint({ space, servers, creds: provCreds, channels: [], consume: false, watchPresence: false, registerPresence: false, watchChannels: false, card: { name: "prov", role: "manager", kind: "endpoint" } });
    prov.on("error", () => {});
    await prov.start();
    const seat = async (name: string): Promise<CotalEndpoint> => {
      const identity = newIdentity();
      const uid = mintLifecycleUid();
      const creds = await provisionAgent(prov, auth, identity, { subscribe: ["general"], allowSubscribe: ["general"], allowPublish: ["general"], lifecycleUid: uid });
      // As connector-core's MeshAgent configures a seat: presence registered, not watched.
      const ep = new CotalEndpoint({ space, servers, creds, lifecycleUid: uid, channels: ["general"], watchPresence: false, heartbeatMs: HEARTBEAT_MS, ttlMs: TTL_MS, card: { id: identity.id, name, kind: "agent" } });
      ep.on("error", () => {});
      ep.on("warning", () => {});
      endpoints.push(ep);
      await ep.start();
      return ep;
    };

    // The presence stream's own consumer count, from the broker's monitor: a watch binds one there,
    // a Direct Get binds none.
    const consumerCount = async (): Promise<number> => {
      const jsz = await (await fetch(`http://127.0.0.1:${monPort}/jsz?accounts=true&streams=true`)).json() as { account_details?: Array<{ stream_detail?: Array<{ name: string; state: { consumer_count: number } }> }> };
      const stream = jsz.account_details?.flatMap((a) => a.stream_detail ?? []).find((st) => st.name === `KV_${presenceBucket(space)}`);
      if (!stream) throw new Error("the presence stream is not on the broker's monitor");
      return stream.state.consumer_count;
    };
    const consumersBefore = await consumerCount();
    const ada = await seat("ada");
    const bob = await seat("bob");
    check("a seat that does not watch holds no roster until it reads", ada.getRoster().length === 0, ada.getRoster());

    const first = await ada.readPresence();
    check("one read returns both seats live", byName(first, "ada")?.status === "idle" && byName(first, "bob")?.status === "idle", first.map((p) => [p.card.name, p.status]));
    check("the read is also what getRoster returns until the next read", ada.getRoster().length === first.length);
    const [r1, r2] = await Promise.all([ada.readPresence(), ada.readPresence()]);
    check("two reads made together agree", r1.length === 2 && r2.length === 2, [r1.length, r2.length]);
    check("neither seat nor any read left a consumer on the presence stream", (await consumerCount()) === consumersBefore, { before: consumersBefore, after: await consumerCount() });

    await bob.stop();
    const afterStop = await ada.readPresence();
    check("a gracefully stopped peer reads offline", byName(afterStop, "bob")?.status === "offline", byName(afterStop, "bob"));

    // The bucket's max_age drops bob's key; a peer an earlier read saw stays on the roster as offline.
    await wait(6_000 + 1_500);
    const keys = (await lastKvEntries((ada as unknown as { kv: KV }).kv)).map((e) => e.key);
    check("control: bob's key has left the bucket", !keys.includes(bob.card.id) && keys.includes(ada.card.id), keys);
    const gone = await ada.readPresence();
    check("a peer whose key left the bucket stays in the roster as offline", byName(gone, "bob")?.status === "offline" && byName(gone, "ada")?.status === "idle", gone.map((p) => [p.card.name, p.status]));

    const supIdentity = newIdentity();
    const supUid = mintLifecycleUid();
    const sup = new CotalEndpoint({ space, servers, creds: await mintCreds(auth, supIdentity, "supervisor", { lifecycleUid: supUid }), lifecycleUid: supUid, channels: [], consume: false, watchPresence: false, watchChannels: false, heartbeatMs: HEARTBEAT_MS, ttlMs: TTL_MS, card: { id: supIdentity.id, name: "sup", role: "manager", kind: "endpoint" } });
    sup.on("error", () => {});
    sup.on("warning", () => {});
    endpoints.push(sup);
    await sup.start();
    let refusal = "";
    try { await sup.readPresence(); } catch (e) { refusal = (e as Error).message; }
    check("a credential without the read grant is refused with the grant named", refusal.includes(`$JS.API.DIRECT.GET.KV_${presenceBucket(space)}`), refusal);
    check("the remedy requires upgrading the issuer before minting again, even for newly minted credentials",
      refusal.includes("newly minted") && refusal.includes("upgrade the manager or auth service") && refusal.includes("reconnecting does not add the grant"), refusal);
    check("a refused read leaves the roster untouched", sup.getRoster().length === 0, sup.getRoster());

    const watcher = new CotalEndpoint({ space, servers, creds: await mintCreds(auth, newIdentity(), "observer"), channels: [], consume: false, registerPresence: false, card: { name: "watcher", kind: "endpoint" } });
    watcher.on("error", () => {});
    endpoints.push(watcher);
    await watcher.start();
    check("control: a watch does bind a consumer on the presence stream", (await consumerCount()) === consumersBefore + 1, { before: consumersBefore, after: await consumerCount() });
    let watching = "";
    try { await watcher.readPresence(); } catch (e) { watching = (e as Error).message; }
    check("a watching endpoint refuses readPresence", /does not watch presence/.test(watching), watching);
    await prov.stop();
  }

  // ---- open mode: paging, the shared decode, staleness -------------------------------------------
  {
    const port = await pickFreePort();
    const servers = `nats://127.0.0.1:${port}`;
    const space = `presence-read-open-${randomUUID().slice(0, 8)}`;
    const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
    dirs.push(dir);
    const broker = spawn("nats-server", ["-js", "-sd", join(dir, "js"), "-p", String(port), "-a", "127.0.0.1"], { stdio: "ignore" });
    brokers.push(broker);
    releases.push(teardownOnSignal(broker, dir));
    await brokerUp(servers, broker);
    await setupSpaceStreams({ servers, space });

    const reader = new CotalEndpoint({ space, servers, channels: [], consume: false, watchPresence: false, heartbeatMs: HEARTBEAT_MS, ttlMs: TTL_MS, card: { name: "reader", kind: "agent" } });
    reader.on("error", () => {});
    reader.on("warning", () => {});
    endpoints.push(reader);
    await reader.start();

    const nc = await connect({ servers });
    try {
      const kv = await new Kvm(nc).open(presenceBucket(space));
      const N = 1_100;
      const record = (id: string, name: string, ts: number) => JSON.stringify({ card: { id, name, kind: "agent" }, status: "idle", ts });
      await Promise.all(Array.from({ length: N }, (_, i) => kv.put(`u_load.seat${i}`, record(`u_load.seat${i}`, `seat${i}`, Date.now()))));
      await kv.put("u_forged.mallory", record("u_load.seat0", "mallory", Date.now()));
      await kv.put("u_old.stale", record("u_old.stale", "stale", Date.now() - 60_000));
      const drops = reader.presenceBindingDropCount;
      const all = await reader.readPresence();
      const live = all.filter((p) => p.card.name.startsWith("seat") && p.status === "idle").length;
      check(`a bucket of ${N + 3} records reads complete (${N} load seats live)`, live === N, { live, rows: all.length });
      check("the reader's own record is in the read", byName(all, "reader")?.status === "idle");
      check("a record whose card.id is not its key is dropped and counted", !byName(all, "mallory") && reader.presenceBindingDropCount === drops + 1, { drops: reader.presenceBindingDropCount - drops });
      check("a record past the liveness window reads offline", byName(all, "stale")?.status === "offline", byName(all, "stale"));
    } finally {
      await nc.close();
    }
  }
} catch (e) {
  failed++;
  console.log(`  x FAIL  fixture: ${(e as Error).stack ?? e}`);
} finally {
  await Promise.all(endpoints.map((ep) => ep.stop().catch(() => {})));
  for (const b of brokers) await killAndAwaitExit(b).catch(() => {});
  for (const r of releases) r();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}

console.log(`\n${failed === 0 ? "PRESENCE READ SMOKE OK" : "PRESENCE READ SMOKE FAILED"}  (${cells - failed} passed, ${failed} failed)`);
process.exit(failed === 0 ? 0 : 1);
