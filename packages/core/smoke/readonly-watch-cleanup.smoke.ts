/** Public watch stop/reconnect under real read-only credentials must not send ungranted deletes.
 *  Uses genuine provisioned subscriptions and the native membership feed, never injected KV rows.
 *  Run: pnpm smoke:readonly-watch-cleanup:auth
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SMOKE_BROKER_TOKEN, teardownOnSignal, killAndAwaitExit } from "@cotal-ai/smoke-kit";
import {
  CotalEndpoint, createSpaceAuth, newIdentity, mintCreds, mintMembershipObserverCreds,
  setupSpaceStreams, serverConfig, provisionAgent, mintLifecycleUid, startMembershipFeed, isReachable,
  membershipBucket, presenceBucket, channelBucket, type MembershipChange,
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
  feed = await startMembershipFeed({ servers, space, accountId: auth.account.pub,
    observerCreds: await mintMembershipObserverCreds(auth, newIdentity()),
    rwCreds: await mintCreds(auth, newIdentity(), "membership-rw") });
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
} finally {
  await feed?.stop();
  for (const ep of endpoints.reverse()) await ep.stop();
  await killAndAwaitExit(broker);
  releaseBroker();
}
console.log(`readonly-watch-cleanup smoke: ${passed}/${passed} checks passed`);
