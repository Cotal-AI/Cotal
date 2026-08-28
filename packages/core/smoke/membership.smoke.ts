/**
 * Full feature test for endpoint.channelMembers() (no test runner) — run with:
 *   pnpm smoke:membership
 * Owns an OS-assigned open JetStream broker and provisions every unique scenario space through
 * the shipped setup seam, so it can run in CI without borrowing an ambient mesh.
 *
 * Covers: per-channel + no-arg map, hierarchical concrete channels, the live/stale/ghost
 * liveness join, observer (consume:false) reads, id-keyed name collisions, custom-id round-trip,
 * per-call freshness, and history-consumer exclusion.
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import {
  CotalEndpoint,
  isReachable,
  chatStream,
  setupSpaceStreams,
  deleteSpace as deleteSpaceResources,
  openMembersRegistry,
  commitMember,
  mintLifecycleUid,
  principalKey,
  DEV_OWNER,
  type ChannelMember,
  type MembershipRecord,
} from "../src/index.js";
import { killAndAwaitExit, SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { pickFreePort } from "./_free-port.js";

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const storeDir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const broker = spawn("nats-server", ["-js", "-sd", storeDir, "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, storeDir);
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

const lifecycleUids = new WeakMap<CotalEndpoint, string>();
const mk = (
  space: string,
  name: string,
  opts: { role?: string; channels?: string[]; id?: string } = {},
): CotalEndpoint => {
  const lifecycleUid = mintLifecycleUid();
  const endpoint = new CotalEndpoint({
    space,
    servers: SERVERS,
    card: { id: opts.id, name, role: opts.role ?? "worker", kind: "agent" },
    channels: opts.channels,
    lifecycleUid,
    heartbeatMs: 300,
    ttlMs: 1500,
  });
  lifecycleUids.set(endpoint, lifecycleUid);
  return endpoint;
};

const membershipRecord = (channel: string, owner: string, lifecycleUid: string): MembershipRecord => ({
  channel,
  owner,
  lifecycleUid,
  state: "durable-active",
  activated: true,
  joinCursor: 0,
  generation: 1,
  writerIdentity: "local.fixture",
  updatedAt: Date.now(),
});

async function seedMemberships(
  space: string,
  entries: Array<{ owner: string; lifecycleUid: string; channels: string[] }>,
): Promise<void> {
  const nc = await connect({ servers: SERVERS });
  try {
    const kv = await openMembersRegistry(nc, space);
    for (const entry of entries)
      for (const channel of entry.channels)
        await commitMember(kv, membershipRecord(channel, entry.owner, entry.lifecycleUid));
  } finally {
    await nc.close();
  }
}

async function seedEndpoints(space: string, entries: Array<[CotalEndpoint, string[]]>): Promise<void> {
  await seedMemberships(space, entries.map(([endpoint, channels]) => ({
    owner: endpoint.card.id,
    lifecycleUid: lifecycleUids.get(endpoint)!,
    channels,
  })));
}

async function provisionSpace(space: string): Promise<boolean> {
  await setupSpaceStreams({ servers: SERVERS, space });
  const nc = await connect({ servers: SERVERS });
  try {
    await (await jetstreamManager(nc)).streams.info(chatStream(space));
    return true;
  } catch {
    return false;
  } finally {
    await nc.close();
  }
}

async function deleteSpace(space: string): Promise<void> {
  await deleteSpaceResources({ servers: SERVERS, space });
}

// [A] per-channel, no-arg map, and hierarchical concrete-channel matching.
async function scenarioA(): Promise<void> {
  console.log("\n[A] matching: per-channel + map + hierarchical concrete channels");
  const space = `mem-a-${randomUUID().slice(0, 8)}`;
  check("A: space streams provisioned", await provisionSpace(space));
  const alice = mk(space, "alice", { role: "planner", channels: ["general"] });
  const bob = mk(space, "bob", { role: "builder", channels: ["general", "review"] });
  const carol = mk(space, "carol", { channels: ["team.backend", "team.frontend", "team.a.b"] });
  const dave = mk(space, "dave", { channels: ["team.backend", "team.frontend"] });
  const eve = mk(space, "eve", { channels: ["team.backend"] });
  const all = [alice, bob, carol, dave, eve];
  all.forEach((e) => e.on("error", (err: Error) => console.error("  !", err.message)));
  for (const e of all) await e.start();
  await seedEndpoints(space, [
    [alice, ["general"]], [bob, ["general", "review"]],
    [carol, ["team.backend", "team.frontend", "team.a.b"]],
    [dave, ["team.backend", "team.frontend"]], [eve, ["team.backend"]],
  ]);
  await wait(800);

  check("general = alice,bob", eq(justNames(await alice.channelMembers("general")), ["alice", "bob"]));
  check("review = bob", eq(justNames(await alice.channelMembers("review")), ["bob"]));
  check("team.backend = carol,dave,eve", eq(justNames(await alice.channelMembers("team.backend")), ["carol", "dave", "eve"]));
  check("team.frontend = carol,dave", eq(justNames(await alice.channelMembers("team.frontend")), ["carol", "dave"]));
  check("team.a.b = carol only", eq(justNames(await alice.channelMembers("team.a.b")), ["carol"]));
  check("unknown channel = []", (await alice.channelMembers("nope")).length === 0);

  const map = await alice.channelMembers();
  check("map keys = concrete durable channels", eq([...map.keys()].sort(), ["general", "review", "team.a.b", "team.backend", "team.frontend"]));
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
  check("B: space streams provisioned", await provisionSpace(space));
  const p1 = mk(space, "p1", { channels: ["general"] });
  const p2 = mk(space, "p2", { channels: ["general"] });
  [p1, p2].forEach((e) => e.on("error", (err: Error) => console.error("  !", err.message)));
  await p1.start();
  await p2.start();
  await seedEndpoints(space, [[p1, ["general"]], [p2, ["general"]]]);
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

  // Foreign/ghost durable membership: a current registry row with no matching presence.
  const ghostPrincipal = principalKey(DEV_OWNER, "GHOST123").key;
  await seedMemberships(space, [{ owner: ghostPrincipal, lifecycleUid: mintLifecycleUid(), channels: ["general"] }]);
  await wait(200);
  const ghost = (await p1.channelMembers("general")).find((m) => m.id === ghostPrincipal);
  check("ghost: foreign durable appears", !!ghost);
  check("ghost: live:false", ghost?.live === false);
  check("ghost: principal id kept when no presence supplies a display name", ghost?.name === ghostPrincipal);

  await p1.stop();
  await deleteSpace(space);
}

// [C] the intended caller: an observer (consume:false) reads membership without being one.
async function scenarioC(): Promise<void> {
  console.log("\n[C] observer (consume:false) reads, isn't a member");
  const space = `mem-c-${randomUUID().slice(0, 8)}`;
  check("C: space streams provisioned", await provisionSpace(space));
  const w1 = mk(space, "w1", { channels: ["general"] });
  const w2 = mk(space, "w2", { channels: ["general", "ops"] });
  [w1, w2].forEach((e) => e.on("error", (err: Error) => console.error("  !", err.message)));
  await w1.start();
  await w2.start();
  await seedEndpoints(space, [[w1, ["general"]], [w2, ["general", "ops"]]]);
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
  check("D: space streams provisioned", await provisionSpace(space));
  const a = mk(space, "worker", { channels: ["general"] });
  const b = mk(space, "worker", { channels: ["general"] });
  [a, b].forEach((e) => e.on("error", (err: Error) => console.error("  !", err.message)));
  await a.start();
  await b.start();
  await seedEndpoints(space, [[a, ["general"]], [b, ["general"]]]);
  await wait(600);
  const workers = (await a.channelMembers("general")).filter((m) => m.name === "worker");
  check("two distinct 'worker' members", workers.length === 2);
  check("distinct real ids", new Set(workers.map((m) => m.id)).size === 2 && [a.card.id, b.card.id].every((id) => workers.some((m) => m.id === id)));
  await a.stop();
  await b.stop();
  await deleteSpace(space);
}

// [E] A caller-selected token-safe id round-trips exactly through durable membership and presence.
async function scenarioE(): Promise<void> {
  console.log("\n[E] custom token-safe id round-trips exactly");
  const space = `mem-e-${randomUUID().slice(0, 8)}`;
  check("E: space streams provisioned", await provisionSpace(space));
  const customId = "node_7";
  check("E: custom id follows the current owner/actor token grammar", /^[A-Za-z0-9_]+$/.test(customId));
  const node = mk(space, "node", { id: customId, channels: ["general"] });
  node.on("error", (err: Error) => console.error("  !", err.message));
  await node.start();
  await seedEndpoints(space, [[node, ["general"]]]);
  await wait(600);
  const m = (await node.channelMembers("general")).find((x) => x.name === "node");
  check("present", !!m);
  check("custom actor id is preserved in the full principal", m?.id === principalKey(DEV_OWNER, customId).key, m?.id);
  check("live", m?.live === true);
  await node.stop();
  await deleteSpace(space);
}

// [F] every call is a fresh round-trip — a join is visible on the next call, no stale cache.
async function scenarioF(): Promise<void> {
  console.log("\n[F] per-call freshness (no cache)");
  const space = `mem-f-${randomUUID().slice(0, 8)}`;
  check("F: space streams provisioned", await provisionSpace(space));
  const a = mk(space, "a", { channels: ["general"] });
  a.on("error", (err: Error) => console.error("  !", err.message));
  await a.start();
  await seedEndpoints(space, [[a, ["general"]]]);
  await wait(500);
  const before = (await a.channelMembers("general")).length;
  const b = mk(space, "b", { channels: ["general"] });
  b.on("error", (err: Error) => console.error("  !", err.message));
  await b.start();
  await seedEndpoints(space, [[b, ["general"]]]);
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
  check("G: space streams provisioned", await provisionSpace(space));
  const a = mk(space, "a", { channels: ["general"] });
  a.on("error", (err: Error) => console.error("  !", err.message));
  await a.start();
  await seedEndpoints(space, [[a, ["general"]]]);
  await wait(400);
  await a.multicast("hi", { channel: "general" });
  await wait(200);
  await a.channelHistory("general"); // creates an ephemeral ordered consumer on the chat stream
  await wait(200);
  check("only 'a' is a member", eq(justNames(await a.channelMembers("general")), ["a"]));
  await a.stop();
  await deleteSpace(space);
}

try {
  let ready = false;
  for (let i = 0; i < 50 && !ready; i++) {
    ready = await isReachable(SERVERS);
    if (!ready) await wait(100);
  }
  check("owned broker is ready before scenarios", ready, SERVERS);

  const scenarios = [scenarioA, scenarioB, scenarioC, scenarioD, scenarioE, scenarioF, scenarioG];
  for (const scenario of scenarios) {
    try {
      await scenario();
    } catch (error) {
      fail++;
      console.error("  ✗ scenario threw:", (error as Error).message);
    }
  }
} finally {
  await killAndAwaitExit(broker);
  check("owned broker exits before its JetStream tree is removed", broker.exitCode !== null || broker.signalCode !== null);
  rmSync(storeDir, { recursive: true, force: true });
  releaseBroker();
}

console.log(
  `
${fail === 0 ? "ALL MEMBERSHIP TESTS PASSED ✅" : "MEMBERSHIP TESTS FAILED ❌"}  (${pass} passed, ${fail} failed)`,
);
process.exit(fail === 0 ? 0 : 1);
