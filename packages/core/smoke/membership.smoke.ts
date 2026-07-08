/**
 * Full feature test for endpoint.channelMembers() (no test runner) — run with:
 *   pnpm smoke:membership
 * Requires an OPEN (unauthenticated) nats-server with JetStream. Override the URL with
 * COTAL_SMOKE_SERVERS (defaults to the standard dev mesh on :4222 — `cotal up --open`).
 *
 * Covers: per-channel + no-arg map, hierarchical/wildcard matching, the live/stale/ghost
 * liveness join, observer (consume:false) reads, id-keyed name collisions, lossy-id
 * forward-match, per-call freshness, and history-consumer exclusion.
 */
import { randomUUID } from "node:crypto";
import { connect } from "@nats-io/transport-node";
import { jetstreamManager, AckPolicy, DeliverPolicy } from "@nats-io/jetstream";
import {
  CotalEndpoint,
  isReachable,
  chatStream,
  dmStream,
  taskStream,
  presenceBucket,
  chatSubject,
  type ChannelMember,
} from "../src/index.js";

const SERVERS = process.env.COTAL_SMOKE_SERVERS ?? "nats://127.0.0.1:4222";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}`, extra ?? "");
  }
};
const justNames = (ms: ChannelMember[]) => ms.map((m) => m.name).sort();
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const mk = (
  space: string,
  name: string,
  opts: { role?: string; channels?: string[]; id?: string } = {},
) =>
  new CotalEndpoint({
    space,
    servers: SERVERS,
    card: { id: opts.id, name, role: opts.role ?? "worker", kind: "agent" },
    channels: opts.channels,
    heartbeatMs: 300,
    ttlMs: 1500,
  });

async function deleteSpace(space: string): Promise<void> {
  const nc = await connect({ servers: SERVERS });
  const jsm = await jetstreamManager(nc);
  for (const s of [chatStream(space), dmStream(space), taskStream(space), `KV_${presenceBucket(space)}`])
    await jsm.streams.delete(s).catch(() => {});
  await nc.close();
}

// [A] per-channel, no-arg map, and hierarchical/wildcard matching.
async function scenarioA(): Promise<void> {
  console.log("\n[A] matching: per-channel + map + hierarchical/wildcard");
  const space = `mem-a-${randomUUID().slice(0, 8)}`;
  const alice = mk(space, "alice", { role: "planner", channels: ["general"] });
  const bob = mk(space, "bob", { role: "builder", channels: ["general", "review"] });
  const carol = mk(space, "carol", { channels: ["team.>"] }); // subtree
  const dave = mk(space, "dave", { channels: ["team.*"] }); // one level
  const eve = mk(space, "eve", { channels: ["team.backend"] }); // concrete
  const all = [alice, bob, carol, dave, eve];
  all.forEach((e) => e.on("error", (err: Error) => console.error("  !", err.message)));
  for (const e of all) await e.start();
  await wait(800);

  check("general = alice,bob", eq(justNames(await alice.channelMembers("general")), ["alice", "bob"]));
  check("review = bob", eq(justNames(await alice.channelMembers("review")), ["bob"]));
  check("team.backend = carol(>),dave(*),eve", eq(justNames(await alice.channelMembers("team.backend")), ["carol", "dave", "eve"]));
  check("team.frontend = carol,dave", eq(justNames(await alice.channelMembers("team.frontend")), ["carol", "dave"]));
  check("team.a.b = carol only (> deep, * shallow)", eq(justNames(await alice.channelMembers("team.a.b")), ["carol"]));
  check("unknown channel = []", (await alice.channelMembers("nope")).length === 0);

  const map = await alice.channelMembers();
  check("map keys = subscribed patterns", eq([...map.keys()].sort(), ["general", "review", "team.*", "team.>", "team.backend"]));
  check("map general = alice,bob", eq(justNames(map.get("general") ?? []), ["alice", "bob"]));

  const g = await alice.channelMembers("general");
  const aliceM = g.find((m) => m.name === "alice");
  check("alice sees herself", !!aliceM);
  check("role preserved (planner)", aliceM?.role === "planner");
  check("real id preserved", aliceM?.id === alice.card.id);
  check("all live", g.every((m) => m.live));

  for (const e of all) await e.stop();
  await deleteSpace(space);
}

// [B] liveness join: live, non-offline statuses, graceful-leave stale, foreign ghost.
async function scenarioB(): Promise<void> {
  console.log("\n[B] liveness: live / status / graceful-leave / ghost");
  const space = `mem-b-${randomUUID().slice(0, 8)}`;
  const p1 = mk(space, "p1", { channels: ["general"] });
  const p2 = mk(space, "p2", { channels: ["general"] });
  [p1, p2].forEach((e) => e.on("error", (err: Error) => console.error("  !", err.message)));
  await p1.start();
  await p2.start();
  await wait(600);

  check("both live", eq(justNames((await p1.channelMembers("general")).filter((m) => m.live)), ["p1", "p2"]));

  await p1.setStatus("working");
  await wait(200);
  check("working status still counts as live", (await p2.channelMembers("general")).find((m) => m.name === "p1")?.live === true);

  await p2.stop(); // graceful: presence flips offline, durable lingers
  await wait(500);
  const afterLeave = await p1.channelMembers("general");
  const p2m = afterLeave.find((m) => m.name === "p2");
  check("graceful-leave: still present", !!p2m);
  check("graceful-leave: live:false (stale)", p2m?.live === false);
  check("graceful-leave: real name kept", p2m?.name === "p2");
  check("graceful-leave: p1 still live", afterLeave.find((m) => m.name === "p1")?.live === true);

  // Foreign/ghost durable: a chat consumer with no matching presence at all.
  const nc = await connect({ servers: SERVERS });
  const jsm = await jetstreamManager(nc);
  await jsm.consumers.add(chatStream(space), {
    durable_name: "chat_GHOST123",
    filter_subjects: [chatSubject(space, "*", "*", "general")],
    ack_policy: AckPolicy.Explicit,
    deliver_policy: DeliverPolicy.All,
  });
  await nc.close();
  await wait(200);
  const ghost = (await p1.channelMembers("general")).find((m) => m.id === "GHOST123");
  check("ghost: foreign durable appears", !!ghost);
  check("ghost: live:false", ghost?.live === false);
  check("ghost: id token kept, never dropped", ghost?.name === "GHOST123");

  await p1.stop();
  await deleteSpace(space);
}

// [C] the intended caller: an observer (consume:false) reads membership without being one.
async function scenarioC(): Promise<void> {
  console.log("\n[C] observer (consume:false) reads, isn't a member");
  const space = `mem-c-${randomUUID().slice(0, 8)}`;
  const w1 = mk(space, "w1", { channels: ["general"] });
  const w2 = mk(space, "w2", { channels: ["general", "ops"] });
  [w1, w2].forEach((e) => e.on("error", (err: Error) => console.error("  !", err.message)));
  await w1.start();
  await w2.start();
  const obs = new CotalEndpoint({
    space,
    servers: SERVERS,
    card: { name: "dash", kind: "endpoint" },
    consume: false,
    registerPresence: false,
    watchPresence: true,
    heartbeatMs: 300,
    ttlMs: 1500,
  });
  obs.on("error", (err: Error) => console.error("  !", err.message));
  await obs.start();
  await wait(800);

  const g = await obs.channelMembers("general");
  check("observer sees w1,w2", eq(justNames(g), ["w1", "w2"]));
  check("observer: all live", g.every((m) => m.live));
  check("observer not a member (no own durable)", !g.some((m) => m.name === "dash"));
  check("observer map: ops = w2", eq(justNames((await obs.channelMembers()).get("ops") ?? []), ["w2"]));

  await w1.stop();
  await w2.stop();
  await obs.stop();
  await deleteSpace(space);
}

// [D] membership is keyed by id, not name — same name twice ⇒ two distinct members.
async function scenarioD(): Promise<void> {
  console.log("\n[D] name collisions keyed by id");
  const space = `mem-d-${randomUUID().slice(0, 8)}`;
  const a = mk(space, "worker", { channels: ["general"] });
  const b = mk(space, "worker", { channels: ["general"] });
  [a, b].forEach((e) => e.on("error", (err: Error) => console.error("  !", err.message)));
  await a.start();
  await b.start();
  await wait(600);
  const workers = (await a.channelMembers("general")).filter((m) => m.name === "worker");
  check("two distinct 'worker' members", workers.length === 2);
  check("distinct real ids", new Set(workers.map((m) => m.id)).size === 2 && [a.card.id, b.card.id].every((id) => workers.some((m) => m.id === id)));
  await a.stop();
  await b.stop();
  await deleteSpace(space);
}

// [E] token() is lossy; forward-match must still return the *real* id, not the token.
async function scenarioE(): Promise<void> {
  console.log("\n[E] lossy-id forward-match recovers the real id");
  const space = `mem-e-${randomUUID().slice(0, 8)}`;
  const node = mk(space, "node", { id: "node.7", channels: ["general"] }); // token('node.7') = 'node_7'
  node.on("error", (err: Error) => console.error("  !", err.message));
  await node.start();
  await wait(600);
  const m = (await node.channelMembers("general")).find((x) => x.name === "node");
  check("present", !!m);
  check("id = real 'node.7' (not token 'node_7')", m?.id === "node.7", m?.id);
  check("live", m?.live === true);
  await node.stop();
  await deleteSpace(space);
}

// [F] every call is a fresh round-trip — a join is visible on the next call, no stale cache.
async function scenarioF(): Promise<void> {
  console.log("\n[F] per-call freshness (no cache)");
  const space = `mem-f-${randomUUID().slice(0, 8)}`;
  const a = mk(space, "a", { channels: ["general"] });
  a.on("error", (err: Error) => console.error("  !", err.message));
  await a.start();
  await wait(500);
  const before = (await a.channelMembers("general")).length;
  const b = mk(space, "b", { channels: ["general"] });
  b.on("error", (err: Error) => console.error("  !", err.message));
  await b.start();
  await wait(500);
  const after = (await a.channelMembers("general")).length;
  check("count grows after a join (1 → 2)", before === 1 && after === 2, { before, after });
  await a.stop();
  await b.stop();
  await deleteSpace(space);
}

// [G] a throwaway history consumer (ephemeral, on the same stream) is not a member.
async function scenarioG(): Promise<void> {
  console.log("\n[G] history ephemeral excluded from membership");
  const space = `mem-g-${randomUUID().slice(0, 8)}`;
  const a = mk(space, "a", { channels: ["general"] });
  a.on("error", (err: Error) => console.error("  !", err.message));
  await a.start();
  await wait(400);
  await a.multicast("hi", { channel: "general" });
  await wait(200);
  await a.channelHistory("general"); // creates an ephemeral ordered consumer on the chat stream
  await wait(200);
  check("only 'a' is a member", eq(justNames(await a.channelMembers("general")), ["a"]));
  await a.stop();
  await deleteSpace(space);
}

for (let i = 0; i < 50; i++) {
  if (await isReachable(SERVERS)) break;
  await wait(200);
}

const scenarios = [scenarioA, scenarioB, scenarioC, scenarioD, scenarioE, scenarioF, scenarioG];
for (const s of scenarios) {
  try {
    await s();
  } catch (e) {
    fail++;
    console.error("  ✗ scenario threw:", (e as Error).message);
  }
}

console.log(
  `\n${fail === 0 ? "ALL MEMBERSHIP TESTS PASSED ✅" : "MEMBERSHIP TESTS FAILED ❌"}  (${pass} passed, ${fail} failed)`,
);
process.exit(fail === 0 ? 0 : 1);
