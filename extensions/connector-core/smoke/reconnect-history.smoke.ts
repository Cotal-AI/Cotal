/** Durable catch-up must not turn an offline channel conversation into new work. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CotalEndpoint, createSpaceAuth, isReachable, mintCreds, mintLifecycleUid,
  newIdentity, provisionAgent, serverConfig, setupSpaceStreams,
} from "@cotal-ai/core";
import { awaitBrokerReady, emitSentinel, freePort, killAndAwaitExit, SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { MeshAgent, fmtItem } from "@cotal-ai/connector-core";

const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const port = await freePort();
const servers = `nats://127.0.0.1:${port}`;
const space = "reconnecthistory";
const channel = "general";
const auth = await createSpaceAuth(space);
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], {
  transport: { kind: "plaintext" }, port, storeDir: join(dir, "js"),
}));
const broker = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const release = teardownOnSignal(broker, dir);
const endpoints: CotalEndpoint[] = [];
const agents: MeshAgent[] = [];
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(test: () => boolean, label: string): Promise<void> {
  for (let n = 0; n < 100; n++) { if (test()) return; await sleep(50); }
  throw new Error(label);
}

try {
  await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 50, delayMs: 100 });
  const creds = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers, space, creds });
  const manager = new CotalEndpoint({
    space, servers, creds, channels: [], consume: false, watchPresence: false, registerPresence: false,
    card: { name: "provisioner", kind: "endpoint" },
  });
  endpoints.push(manager);
  await manager.start();
  const delivery = new CotalEndpoint({
    space, servers, creds: await mintCreds(auth, newIdentity(), "delivery"),
    channels: [], consume: false, watchPresence: true, registerPresence: false,
    card: { name: "delivery", kind: "endpoint" },
  });
  endpoints.push(delivery);
  await delivery.start();
  await delivery.startPlane3((owner, uid) => delivery.aclForOwner(owner, uid));
  const lease = await delivery.acquireDeliveryLease(0);
  await delivery.markDeliveryLeaseReady(0, lease);
  const grant = { allowSubscribe: [channel], allowPublish: [channel], subscribe: [channel] };
  async function identity() {
    const id = newIdentity();
    const uid = mintLifecycleUid();
    const creds = await provisionAgent(manager, auth, id, { ...grant, lifecycleUid: uid });
    return { id, uid, creds };
  }
  async function seat(name: string, issued: Awaited<ReturnType<typeof identity>>) {
    const agent = new MeshAgent({
      space, servers, tls: false, name, id: issued.id.id, creds: issued.creds, lifecycleUid: issued.uid,
      subscribe: [channel], allowSubscribe: [channel], allowPublish: [channel], kind: "agent",
    });
    agents.push(agent);
    await agent.start();
    return agent;
  }
  const alice = await identity();
  const publisher = new CotalEndpoint({
    space, servers, creds: alice.creds, lifecycleUid: alice.uid, channels: [channel],
    consume: false, watchPresence: false, registerPresence: false,
    card: { id: alice.id.id, name: "alice", kind: "agent" },
  });
  endpoints.push(publisher);
  await publisher.start();
  const bob = await identity();
  const first = await seat("bob", bob);
  assert(first.ep.hasDurableMembership(channel), "the returning seat must have a durable membership");
  await first.stop();
  const old = [
    await publisher.multicast("offline ambient one", { channel }),
    await publisher.multicast("offline mention", { channel, mentions: ["bob"] }),
    await publisher.multicast("offline ambient two", { channel }),
  ];
  const ids = new Set(old.map((msg) => msg.id));
  const offlineDm = await publisher.unicast(first.id, "offline direct request");
  const returned = await seat("bob", bob);
  await until(() => returned.peekInbox("all").filter((item) => ids.has(item.id)).length === old.length, "returning seat missed durable copies");
  const fresh = await seat("fresh", await identity());
  await until(() => fresh.peekInbox("pull-only").filter((item) => ids.has(item.id)).length === old.length, "fresh join missed replay");
  assert.equal(fresh.peekInbox("automatic").filter((item) => ids.has(item.id)).length, 0);
  assert(fresh.peekInbox("pull-only").filter((item) => ids.has(item.id)).every((item) => item.historical && fmtItem(item).includes("(history)")));
  console.log("PASS positive control: fresh join replay is historical and pull-only");
  console.log(JSON.stringify({
    returningAutomatic: returned.peekInbox("automatic").filter((item) => ids.has(item.id)).length,
    returningPullOnly: returned.peekInbox("pull-only").filter((item) => ids.has(item.id)).length,
    frames: returned.peekInbox("all").filter((item) => ids.has(item.id)).map((item) => fmtItem(item)),
  }));
  assert.equal(returned.peekInbox("automatic").filter((item) => ids.has(item.id)).length, 0, "offline durable channel copies must not start turns");
  const history = returned.peekInbox("pull-only").filter((item) => ids.has(item.id));
  assert.equal(history.length, old.length);
  assert(history.every((item) => item.historical && fmtItem(item).includes("(history)")));
  await until(() => returned.peekInbox("automatic").some((item) => item.id === offlineDm.id), "offline DM must remain automatic");
  assert.equal(returned.peekInbox("automatic").filter((item) => item.kind === "channel").length, 0, "even an old mention must not wake");
  const payload = JSON.stringify(history[0]);
  const python = spawn("python3", ["-c", "import json,sys; sys.path.insert(0, 'extensions/connector-hermes/plugin'); from cotal.framing import format_injection; print(format_injection(json.loads(sys.stdin.read())))"], { stdio: ["pipe", "pipe", "pipe"] });
  let hermesFrame = "";
  let pythonError = "";
  python.stdout.on("data", (data) => { hermesFrame += data; });
  python.stderr.on("data", (data) => { pythonError += data; });
  const framed = new Promise<void>((resolve, reject) => {
    python.once("error", reject);
    python.once("close", (code) => code === 0 ? resolve() : reject(new Error(pythonError)));
  });
  python.stdin.end(payload);
  await framed;
  assert(hermesFrame.includes("(history)"), "the shipped Hermes formatter must see the history classification");
  console.log("PASS returning seat: durable ambient posts and mentions are historical and pull-only");
  const ambient = await publisher.multicast("current ambient", { channel });
  await until(() => returned.peekInbox("automatic").some((item) => item.id === ambient.id), "current ambient channel post did not arrive automatically");
  const current = await publisher.multicast("current request", { channel, mentions: ["bob"] });
  await until(() => returned.peekInbox("automatic").some((item) => item.id === current.id), "current channel mention did not arrive automatically");
  const dm = await publisher.unicast(returned.id, "current DM");
  await until(() => returned.peekInbox("automatic").some((item) => item.id === dm.id), "current DM did not arrive automatically");
  assert(returned.peekInbox("automatic").every((item) => !item.historical));
  console.log("PASS live controls: current ambient, current mentions, current DMs and offline DMs remain automatic");
  assert((await returned.reconnect()).ok);
  assert(returned.peekInbox("automatic").some((item) => item.id === current.id && !item.historical), "a reconnect must not demote already buffered live mail");
  console.log("PASS coalescing control: buffered live mail keeps its classification across reconnect");
} finally {
  for (const agent of agents.reverse()) await agent.stop();
  for (const endpoint of endpoints.reverse()) await endpoint.stop();
  await killAndAwaitExit(broker);
  release();
}
emitSentinel({ passed: 4, failed: 0 });
