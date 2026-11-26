/** Public watch stop/reconnect under real read-only credentials must not send ungranted deletes.
 *  Uses genuine provisioned subscriptions and the native membership feed, never injected KV rows.
 *  Run: pnpm smoke:readonly-watch-cleanup:auth
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { SMOKE_BROKER_TOKEN, teardownOnSignal, killAndAwaitExit } from "@cotal-ai/smoke-kit";
import {
  CotalEndpoint, createSpaceAuth, newIdentity, mintCreds, mintMembershipObserverCreds,
  setupSpaceStreams, serverConfig, provisionAgent, mintLifecycleUid, startMembershipFeed, isReachable,
  membershipBucket, presenceBucket, channelBucket, standaloneConnectOpts, type MembershipChange,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

let passed = 0;
function check(name: string, condition: boolean): void {
  if (!condition) throw new Error(name);
  passed++;
  console.log(`  ✓ ${name}`);
}
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(name: string, predicate: () => boolean | Promise<boolean>): Promise<void> {
  const end = Date.now() + 10_000;
  while (Date.now() < end) {
    if (await predicate()) return;
    await delay(20);
  }
  throw new Error(`deadline: ${name}`);
}

function membershipWatchState(endpoint: CotalEndpoint) {
  const { conn } = endpoint as unknown as {
    conn: { nc: NatsConnection; membershipFeedWatches: Set<{
      arm: Promise<void>; consumerName: string; iter: { monitor: { _change(interval: number): void } };
    }> };
  };
  return { nc: conn.nc, intent: [...conn.membershipFeedWatches][0]! };
}

async function checkSameStoreReset(
  reader: CotalEndpoint, stream: string, names: (stream: string) => Promise<string[]>, poll: () => Promise<void>,
): Promise<void> {
  const changes: MembershipChange[] = [];
  const watch = await reader.watchMembership((change) => changes.push(change));
  try {
    await until("initial replay before same-store reset", () => changes.some((change) => change.type === "replayed"));
    changes.length = 0;
    const { intent } = membershipWatchState(reader);
    const previous = intent.consumerName;
    const prefix = previous.slice(0, previous.lastIndexOf("_") + 1);
    const incoming = async () => (await names(stream)).some((name) => name !== previous && name.startsWith(prefix) && name === intent.consumerName);
    // Run the actual ordered consumer reset with a shorter native idle timeout.
    const { monitor } = intent.iter;
    monitor._change(200);
    try {
      await until("native consumer serial advances on the same stream", incoming);
      await intent.arm;
    } finally { monitor._change(30_000); }
    await poll();
    await until("live heartbeat after same-store reset", () => changes.some((change) => change.type === "heartbeat" && change.update));
    check("same-store reset delivers a live heartbeat without replaying entries", changes.every((change) => change.type !== "replayed" && change.update));
  } finally { await watch.stop(); }
}

async function checkResetInfoFailure(reader: CotalEndpoint, stream: string): Promise<void> {
  let replayed = false;
  const watch = await reader.watchMembership((change) => { if (change.type === "replayed") replayed = true; });
  const { nc, intent } = membershipWatchState(reader);
  const { monitor } = intent.iter;
  const request = nc.request;
  const fault = new Error("fixture: transient membership STREAM.INFO failure");
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  const reported: Error[] = [];
  const onError = (err: Error) => reported.push(err);
  let attempts = 0;
  nc.request = (subject, payload, opts) => {
    if (subject !== `$JS.API.STREAM.INFO.${stream}`) return request.call(nc, subject, payload, opts);
    attempts++;
    monitor._change(30_000);
    return attempts <= 2 ? Promise.reject(fault) : request.call(nc, subject, payload, opts);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    await until("initial replay before failed stream info", () => replayed);
    reader.on("error", onError);
    monitor._change(200);
    await until("endpoint reports the failed stream info to its listener", () => reported.length > 0);
    check("the reset reports its transient stream info failure to a listening endpoint", reported.length === 1 && reported[0] === fault);
    reader.off("error", onError);
    check("the second reset runs without an endpoint error listener", reader.listenerCount("error") === 0);
    monitor._change(200);
    await until("stream info was attempted without an endpoint error listener", () => attempts === 2);
    await new Promise<void>((resolve) => setImmediate(resolve));
    check(`a listenerless reset creates no unhandled rejection (observed: ${unhandled.map(String).join(", ")})`, unhandled.length === 0);
    monitor._change(200);
    await until("later native reset checks stream info again", () => attempts === 3);
    await intent.arm;
    check("the follower keeps checking resets after the transient failure", true);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    reader.off("error", onError);
    nc.request = request;
    await watch.stop();
  }
}

const port = await pickFreePort();
const monitorPort = await pickFreePort();
const servers = `nats://127.0.0.1:${port}`;
const space = `readonlywatch-${port}`;
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const auth = await createSpaceAuth(space);
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], {
  host: "127.0.0.1", port, transport: { kind: "plaintext" }, storeDir: join(dir, "js"),
}) + `\nhttp: "127.0.0.1:${monitorPort}"\n`, { mode: 0o600 });
let brokerLog = "";
const broker = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: ["ignore", "pipe", "pipe"] });
const releaseBroker = teardownOnSignal(broker, dir);
for (const output of [broker.stdout, broker.stderr]) output.on("data", (chunk: Buffer) => { brokerLog += chunk.toString(); });
const endpoints: CotalEndpoint[] = [];
let feed: Awaited<ReturnType<typeof startMembershipFeed>> | undefined;
try {
  const provisionerCreds = await mintCreds(auth, newIdentity(), "provisioner");
  await until("owned broker ready", () => isReachable(servers));
  await setupSpaceStreams({ servers, space, creds: provisionerCreds });
  const errors: Error[] = [];
  const endpoint = (creds: string, watch = false): CotalEndpoint => {
    const ep = new CotalEndpoint({ servers, space, creds, consume: false, registerPresence: false,
      watchPresence: watch, watchChannels: watch, channels: [], card: { name: "watch-reader", kind: "endpoint" } });
    ep.on("error", (error: Error) => { errors.push(error); });
    endpoints.push(ep);
    return ep;
  };
  const provisioner = endpoint(provisionerCreds);
  await provisioner.start();
  const id = newIdentity(), lifecycleUid = mintLifecycleUid();
  const creds = await provisionAgent(provisioner, auth, id, {
    allowSubscribe: ["general", "review"], allowPublish: ["general"], subscribe: [], lifecycleUid,
  });
  const poster = new CotalEndpoint({ servers, space, creds, lifecycleUid, consume: true,
    registerPresence: false, watchPresence: false, watchChannels: false, channels: ["general"],
    card: { name: "genuine-subscriber", kind: "agent", id: id.id } });
  poster.on("error", (error: Error) => { errors.push(error); });
  endpoints.push(poster);
  await poster.start();
  const startFeed = async () => startMembershipFeed({ servers, space, accountId: auth.account.pub,
    observerCreds: await mintMembershipObserverCreds(auth, newIdentity()),
    rwCreds: await mintCreds(auth, newIdentity(), "membership-rw") });
  feed = await startFeed();
  const streams = [membershipBucket(space), presenceBucket(space), channelBucket(space)].map((bucket) => `KV_${bucket}`);
  const names = async (stream: string): Promise<string[]> => {
    // Out-of-band observation needs no product credential or extra broker grant.
    const response = await fetch(`http://127.0.0.1:${monitorPort}/jsz?accounts=true&streams=true&consumers=true`);
    if (!response.ok) throw new Error(`monitor: ${response.status}`);
    const state = await response.json() as {
      account_details?: { stream_detail?: { name: string; consumer_detail?: { name: string }[] }[] }[];
    };
    const observed = state.account_details?.flatMap((account) => account.stream_detail ?? []).find((item) => item.name === stream);
    if (!observed) throw new Error(`missing stream ${stream}`);
    return (observed.consumer_detail ?? []).map((consumer) => consumer.name);
  };
  const reader = endpoint(await mintCreds(auth, newIdentity(), "admin"), true);
  await reader.start();
  await reader.waitForPresenceSnapshot();
  check("nonempty public membership read", (await reader.readMembership()).members.some((member) => member.live.includes("general")));
  const changes: MembershipChange[] = [];
  const watch = await reader.watchMembership((change) => { changes.push(change); });
  await until("nonempty watch replay", () => changes.some((change) => change.type === "member") && changes.some((change) => change.type === "replayed"));
  check("all three actual watch consumers exist", (await Promise.all(streams.map(names))).every((list) => list.length === 1));
  await watch.stop();
  const stoppedCount = changes.length;
  await poster.joinChannel("review");
  await feed.poll();
  check("stopped watch receives no callbacks on fresh actual updates", changes.length === stoppedCount);
  check("read-only stop leaves its native inactive consumer", (await names(streams[0]!)).length === 1);
  const rebound: MembershipChange[] = [];
  const watch2 = await reader.watchMembership((change) => { rebound.push(change); });
  await until("second replay", () => rebound.some((change) => change.type === "replayed"));
  await reader.reconnect();
  await until("reconnect rearm", () => rebound.filter((change) => change.type === "replayed").length === 2);
  await poster.leaveChannel("review");
  await feed.poll();
  await until("fresh actual rebound update", () => rebound.some((change) => change.type === "member" && change.update && change.member !== undefined && !change.member.live.includes("review")));
  check("public reconnect rearms and delivers fresh actual updates", true);
  await watch2.stop();
  await reader.stop();
  const retained = await Promise.all(streams.map(names));
  check("read-only stop does not delete streams or hide retained consumers", retained.every((list) => list.length > 0));
  const control = endpoint(await mintCreds(auth, newIdentity(), "delivery"), true);
  await control.start();
  await control.waitForPresenceSnapshot();
  const granted = await Promise.all(streams.slice(1).map(names));
  check("already-granted control creates both native watch consumers", granted.every((list, i) => list.length === retained[i + 1]!.length + 1));
  await control.stop();
  const reclaimed = await Promise.all(streams.slice(1).map(names));
  check("already-granted control immediately reclaims both consumers", reclaimed.every((list, i) => list.length === retained[i + 1]!.length));
  await delay(50);
  check("no lifecycle DELETE permission violations on the real broker", !brokerLog.split("\n").some((line) => line.includes("Violation") && line.includes("CONSUMER.DELETE.")));
  check("public lifecycle remained free of endpoint errors", errors.length === 0);

  const resetCreds = await mintCreds(auth, newIdentity(), "observer");
  const resetReader = endpoint(resetCreds);
  await resetReader.start();
  await checkSameStoreReset(resetReader, streams[0]!, names, () => feed!.poll());
  check("same-store reset causes no endpoint error", errors.length === 0);
  await resetReader.stop();

  const faultReader = new CotalEndpoint({ servers, space, creds: resetCreds, consume: false, registerPresence: false,
    watchPresence: false, watchChannels: false, channels: [], card: { name: "fault-reader", kind: "endpoint" } });
  endpoints.push(faultReader);
  await faultReader.start();
  await checkResetInfoFailure(faultReader, streams[0]!);
  await faultReader.stop();

  const replacementReader = endpoint(await mintCreds(auth, newIdentity(), "observer"));
  await replacementReader.start();
  const transportEdges: unknown[] = [];
  replacementReader.on("transport", (edge) => transportEdges.push(edge));
  const deleteId = newIdentity();
  const deleteCreds = await mintCreds(auth, deleteId, "membership-store-recreate");
  const deleteNc = await connect({ servers, ...standaloneConnectOpts({ creds: deleteCreds, tls: false }), inboxPrefix: `_INBOX_${deleteId.id}` });
  let replacementWatch: { stop(): Promise<void> } | undefined;
  try {
    const jsm = await jetstreamManager(deleteNc, { checkAPI: false });
    const stream = streams[0]!;
    const lastSeq = async () => (await jsm.streams.info(stream)).state.last_seq;
    for (let i = 0; i < 8; i++) await feed.poll();
    const oldRevision = await lastSeq();
    const replacement: MembershipChange[] = [];
    replacementWatch = await replacementReader.watchMembership((change) => replacement.push(change));
    await until("old store heartbeat", () => replacement.some((c) => c.type === "heartbeat" && c.revision >= oldRevision));
    await feed.stop();
    check("delete the membership stream on the running broker", await jsm.streams.delete(stream));
    await setupSpaceStreams({ servers, space, creds: provisionerCreds });
    feed = await startFeed();
    check("replacement writer stamps a heartbeat below the old cursor", (await lastSeq()) < oldRevision);
    replacement.length = 0;
    // Shorten only this watch's idle timeout. The native reset and replay still run against the broker.
    const { monitor } = membershipWatchState(replacementReader).intent.iter;
    monitor._change(200);
    await until("replacement store replay", () => replacement.some((c) => c.type === "replayed"));
    check("the existing watch replays the replacement's members and heartbeat below its old cursor",
      replacement.some((c) => c.type === "member" && !c.update && c.member?.live.includes("general"))
      && replacement.some((c) => c.type === "heartbeat" && !c.update && c.revision < oldRevision));
    await feed.poll();
    await until("replacement live heartbeat", () => replacement.some((c) => c.type === "heartbeat" && c.update));
    check("the replacement watch continues delivering without a transport edge or endpoint error", transportEdges.length === 0 && errors.length === 0);
  } finally {
    await replacementWatch?.stop();
    await deleteNc.close();
  }
} finally {
  await feed?.stop();
  for (const ep of endpoints.reverse()) await ep.stop();
  await killAndAwaitExit(broker);
  if (broker.exitCode === null && broker.signalCode === null) throw new Error("owned broker has not exited before fixture cleanup");
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
}
console.log(`readonly-watch-cleanup smoke: ${passed}/${passed} checks passed`);
