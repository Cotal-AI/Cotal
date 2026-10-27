/**
 * The delivery daemon's `lifecycleMemberships` inventory under a mass stop (#4965), against the shipped
 * daemon (`_boot-delivery.ts`), its own admin-rail handler and the shipped inventory read.
 *
 * A stop retires every seat at once. Each retirement sends an `evictPrincipal` and then its inventory to
 * the daemon's admin rail, which answered one request at a time, so inventories queued behind the other
 * seats' evictions missed their 5 s deadline and kept rows they should have purged. Each inventory also
 * read the whole members bucket on its own, so N retirements cost N passes. This suite counts:
 *   - 50 inventories answered while an eviction is held open in front of them on the same rail;
 *   - each answer complete and lifecycle-exact: tombstones in, other lifecycles and purged rows out;
 *   - 50 concurrent inventories served by 2 passes over the bucket;
 *   - an answer from a pass that began after its request: a row written while a pass ran is in the
 *     answer to a request sent after it;
 *   - a pass that fails refuses every request that waited on it, and none reads as an empty list;
 *   - a lifecycle's memberships stop changing once its inventory is asked for, with the seats still
 *     connected: a join already running is waited for and listed, a join that was queued on the
 *     daemon's serial `ctl.delivery` rail before the inventory and runs after it is refused, and so are
 *     later joins and leaves, while other lifecycles still join. After the real deprovisioner purges
 *     the listed keys, the lifecycle has 0 rows on the broker.
 *
 * Run: pnpm smoke:lifecycle-inventory-concurrency (needs nats-server on PATH)
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CotalEndpoint, createSpaceAuth, deprovisionAgent, DEV_OWNER, listMembers, memberKey, mintCreds, mintLifecycleUid, newIdentity,
  openMembersRegistry, principalKey, provisionAgent, setupSpaceStreams, type ControlReply, type ControlRequest,
} from "@cotal-ai/core";
import { workspaceSecretStore } from "@cotal-ai/workspace";
import { createSuite } from "@cotal-ai/smoke-kit";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import type { KV } from "@nats-io/kv";
import { bootBroker } from "./_boot-broker.js";
import { bootDeliveryDaemon } from "./_boot-delivery.js";

const { check, finish } = createSuite();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const N = 50;

const space = `invconc-${Math.random().toString(36).slice(2, 8)}`;
const auth = await createSpaceAuth(space);
const broker = await bootBroker(auth);
const ws = mkdtempSync(join(tmpdir(), "invconc-"));
let daemon: Awaited<ReturnType<typeof bootDeliveryDaemon>> | undefined;
let caller: CotalEndpoint | undefined;
const endpoints: CotalEndpoint[] = [];
let writer: Awaited<ReturnType<typeof connect>> | undefined;
try {
  await setupSpaceStreams({ servers: broker.servers, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  // An eviction the suite can hold open on the rail: `holdEviction` arms it, the next eviction waits.
  let evictionHeld: { entered: () => void; release: Promise<void> } | undefined;
  daemon = await bootDeliveryDaemon({
    space, servers: broker.servers, auth, reloadStoreIdentity: workspaceSecretStore(ws).identity,
    onEvict: async () => {
      const held = evictionHeld;
      evictionHeld = undefined;
      if (held) { held.entered(); await held.release; }
    },
  });
  // Count inventory requests as the daemon's rail hands them to its handler.
  let arrived = 0;
  const d = daemon.ep as unknown as { handleDeliveryAdmin(req: ControlRequest): Promise<ControlReply>; membersRegistry(): Promise<KV> };
  const handle = d.handleDeliveryAdmin.bind(d);
  d.handleDeliveryAdmin = (req) => { if (req.op === "lifecycleMemberships") arrived++; return handle(req); };
  // Count the inventory's passes over the bucket on the daemon's own members handle, and let the suite
  // hold a pass at its start or fail it.
  const consumers = (await d.membersRegistry() as unknown as { js: { consumers: { getPushConsumer: (...a: unknown[]) => Promise<unknown> } } }).js.consumers;
  const bind = consumers.getPushConsumer.bind(consumers);
  let passes = 0;
  let passHeld: { entered: () => void; release: Promise<void> } | undefined;
  let failPasses = false;
  consumers.getPushConsumer = async (...a) => {
    passes++;
    if (failPasses) throw new Error("injected: the pass could not bind its consumer");
    const held = passHeld;
    passHeld = undefined;
    if (held) { held.entered(); await held.release; }
    return bind(...a);
  };

  const callerId = newIdentity();
  caller = new CotalEndpoint({
    space, servers: broker.servers, creds: await mintCreds(auth, callerId, "supervisor"),
    card: { id: callerId.id, name: "inventory-caller", role: "supervisor", kind: "endpoint" },
    channels: [], consume: false, watchPresence: false, registerPresence: false, watchChannels: false,
  });
  caller.on("error", () => {});
  await caller.start();
  const inventory = (l: { principal: string; uid: string }, deadlineMs = 5_000) =>
    caller!.requestDeliveryAdmin("lifecycleMemberships", { principal: l.principal, lifecycleUid: l.uid }, deadlineMs)
      .catch((e: Error): ControlReply => ({ ok: false, error: `request failed: ${e.message}` }));

  // The bucket: N lifecycles on general + team.api, every fifth also holding a tombstone on ops; each
  // principal's earlier lifecycle on general; and one row per lifecycle that was purged.
  const writerId = newIdentity();
  writer = await connect({ servers: broker.servers, inboxPrefix: `_INBOX_${writerId.id}`, authenticator: credsAuthenticator(new TextEncoder().encode(await mintCreds(auth, writerId, "delivery"))) });
  const kv = await openMembersRegistry(writer, space);
  const row = (channel: string, principal: string, uid: string, leaveCursor?: number) =>
    kv.put(memberKey(channel, principal, uid), JSON.stringify({ channel, owner: principal, lifecycleUid: uid, state: "live-confirmed", joinCursor: 1, activated: true, generation: 1, writerIdentity: "smoke", updatedAt: Date.now(), ...(leaveCursor === undefined ? {} : { leaveCursor }) }));
  const seats = Array.from({ length: N }, (_, i) => ({ principal: `${DEV_OWNER}.seat${i}`, uid: mintLifecycleUid(), expected: ["general", "team.api", ...(i % 5 === 0 ? ["ops"] : [])] }));
  await Promise.all(seats.map(async (s) => {
    await row("general", s.principal, s.uid);
    await row("team.api", s.principal, s.uid);
    if (s.expected.includes("ops")) await row("ops", s.principal, s.uid, 7);
    await row("general", s.principal, mintLifecycleUid());
    await row("gone", s.principal, s.uid);
    await kv.purge(memberKey("gone", s.principal, s.uid));
  }));
  const exact = (r: ControlReply, expected: string[]) => {
    const data = r.data as { complete?: unknown; channels?: unknown } | undefined;
    return r.ok && data?.complete === true && JSON.stringify(data.channels) === JSON.stringify([...expected].sort());
  };

  // 1. Inventories do not queue behind an eviction held open on the same rail.
  let releaseEviction!: () => void;
  const entered = new Promise<void>((resolve) => { evictionHeld = { entered: resolve, release: new Promise((r) => { releaseEviction = r; }) }; });
  let evictionSettled = false;
  const eviction = caller.requestDeliveryAdmin("evictPrincipal", { principal: `${DEV_OWNER}.${newIdentity().id}` }, 60_000).finally(() => { evictionSettled = true; });
  await entered;
  const held = await Promise.all(seats.map((s) => inventory(s)));
  check(`all ${N} inventories are answered within 5 s while an eviction is held open in front of them on the rail`,
    held.every((r) => r.ok) && !evictionSettled, { ok: held.filter((r) => r.ok).length, errors: [...new Set(held.filter((r) => !r.ok).map((r) => r.error))], evictionSettled });
  check(`each of the ${N} answers is complete and lifecycle-exact: its tombstone in, its earlier lifecycle and its purged row out`,
    held.every((r, i) => exact(r, seats[i].expected)), held.find((r, i) => !exact(r, seats[i].expected)));
  releaseEviction();
  const evicted = await eviction;
  check("the held eviction completes once released", evicted.ok === true, evicted);

  // 2. Concurrent inventories share passes, and each answer comes from a pass that began after its request.
  passes = 0;
  arrived = 0;
  let releasePass!: () => void;
  const passEntered = new Promise<void>((resolve) => { passHeld = { entered: resolve, release: new Promise((r) => { releasePass = r; }) }; });
  const first = inventory(seats[1], 60_000);
  await passEntered;
  // Written while the first pass is held at its start: an inventory asked after this must list it.
  await row("late", seats[0].principal, seats[0].uid);
  const rest = seats.filter((_, i) => i !== 1).map((s) => inventory(s, 60_000));
  for (let i = 0; i < 600 && arrived < N; i++) await wait(50);
  await wait(200);
  check(`all ${N} inventory requests reached the daemon while the first pass was held`, arrived === N, { arrived });
  releasePass();
  const shared = [await first, ...await Promise.all(rest)];
  const order = [seats[1], ...seats.filter((_, i) => i !== 1)];
  check(`${N} concurrent inventories took 2 passes over the bucket`, passes === 2, { passes });
  check(`the ${N} shared answers are each complete and lifecycle-exact`,
    shared.slice(1).every((r, i) => exact(r, order[i + 1] === seats[0] ? [...seats[0].expected, "late"] : order[i + 1].expected)) && exact(shared[0], seats[1].expected),
    shared.find((r, i) => !exact(r, order[i] === seats[0] ? [...seats[0].expected, "late"] : order[i].expected)));
  check("a row written while a pass ran is in the answer to a request sent after it",
    exact(shared[order.indexOf(seats[0])], [...seats[0].expected, "late"]), shared[order.indexOf(seats[0])]);

  // 3. A failed pass is a refusal to everyone who waited on it, never an empty inventory.
  failPasses = true;
  const refused = await Promise.all(seats.slice(0, 10).map((s) => inventory(s)));
  failPasses = false;
  check("every inventory that waited on a failed pass is refused with the read's failure",
    refused.every((r) => !r.ok && /inventory read did not complete/.test(r.error ?? "")), refused.find((r) => r.ok || !/inventory read did not complete/.test(r.error ?? "")));
  check("no refused inventory carries a channel list", refused.every((r) => r.data === undefined), refused.find((r) => r.data !== undefined));
  const after = await inventory(seats[2]);
  check("the next inventory after a failed pass reads the bucket again", exact(after, seats[2].expected), after);

  // 4. A lifecycle's memberships stop changing once its inventory is asked for. The seats stay
  //    connected, as a user-mode seat's bearer can be until the auth plane evicts it.
  const prov = new CotalEndpoint({ space, servers: broker.servers, creds: await mintCreds(auth, newIdentity(), "provisioner"), channels: [], consume: false, watchPresence: false, registerPresence: false, card: { name: "prov", role: "manager", kind: "endpoint" } });
  endpoints.push(prov);
  prov.on("error", () => {});
  await prov.start();
  const seat = async (name: string, id = newIdentity()) => {
    const uid = mintLifecycleUid();
    const creds = await provisionAgent(prov, auth, id, { subscribe: ["lane.a"], allowSubscribe: ["lane.>"], lifecycleUid: uid });
    const ep = new CotalEndpoint({ space, servers: broker.servers, creds, channels: [], consume: false, lifecycleUid: uid, watchPresence: false, registerPresence: false, card: { id: id.id, name, role: "agent", kind: "agent" } });
    endpoints.push(ep);
    ep.on("error", () => {});
    await ep.start();
    return { id, uid, ep, principal: principalKey(DEV_OWNER, id.id).key };
  };
  type Seat = Awaited<ReturnType<typeof seat>>;
  const rowsOf = async (s: Seat) => (await listMembers(kv, { owner: s.principal })).filter((r) => r.lifecycleUid === s.uid);
  const outcome = (p: Promise<unknown>) => p.then(() => "ok", (e: Error) => e.message);
  // Hold the daemon's next durable join at its start, after the ACL authorized it.
  const dj = daemon.ep as unknown as { durableJoinFor(owner: string, channel: string, uid: string): Promise<unknown>; deliveryServeSub: { getPending(): number }; retiringLifecycles: Map<string, Set<string>> };
  const joinFor = dj.durableJoinFor.bind(dj);
  let joinHeld: { entered: () => void; release: Promise<void> } | undefined;
  dj.durableJoinFor = async (owner, channel, uid) => {
    const h = joinHeld;
    joinHeld = undefined;
    if (h) { h.entered(); await h.release; }
    return joinFor(owner, channel, uid);
  };
  const holdJoin = () => {
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { joinHeld = { entered: resolve, release: new Promise((r) => { release = r; }) }; });
    return { entered, release: () => release() };
  };

  const a = await seat("seat-a");
  const aJoined = await a.ep.durableJoinChannel("lane.a");
  const running = holdJoin();
  const runningJoin = outcome(a.ep.durableJoinChannel("lane.b"));
  await running.entered;
  let answered = false;
  const waited = inventory({ principal: a.principal, uid: a.uid }, 30_000).finally(() => { answered = true; });
  await wait(1000);
  check("an inventory does not read while a join of its lifecycle authorized before it is still running", !answered);
  running.release();
  const [joined, listing] = await Promise.all([runningJoin, waited]);
  check("that join completes and its row is in the inventory's answer", joined === "ok" && exact(listing, ["lane.a", "lane.b"]), { joined, listing });
  const lateJoin = await outcome(a.ep.durableJoinChannel("lane.c"));
  const lateLeave = await outcome(a.ep.durableLeaveChannel("lane.a", aJoined.generation));
  check("a join of the lifecycle sent after its inventory is refused as retiring", /is retiring/.test(lateJoin), lateJoin);
  check("a leave of the lifecycle sent after its inventory is refused as retiring", /is retiring/.test(lateLeave), lateLeave);
  const aRows = await rowsOf(a);
  check("the broker holds the lifecycle's 2 listed rows unchanged: no lane.c row, lane.a not tombstoned",
    aRows.map((r) => r.channel).sort().join() === "lane.a,lane.b" && aRows.every((r) => r.leaveCursor === undefined), aRows);

  // A join queued on the serial ctl.delivery rail before the inventory, and run after it.
  const b = await seat("seat-b"), c = await seat("seat-c");
  const blocking = holdJoin();
  const bJoin = outcome(b.ep.durableJoinChannel("lane.a"));
  await blocking.entered;
  const cJoin = outcome(c.ep.durableJoinChannel("lane.a"));
  for (let i = 0; i < 100 && dj.deliveryServeSub.getPending() < 1; i++) await wait(50);
  const queued = dj.deliveryServeSub.getPending();
  const cListing = await inventory({ principal: c.principal, uid: c.uid });
  blocking.release();
  const [bOutcome, cOutcome] = await Promise.all([bJoin, cJoin]);
  check("with a join queued behind a running one, the inventory of the queued join's lifecycle answers an empty list",
    queued === 1 && exact(cListing, []), { queued, cListing });
  check("the queued join runs after the inventory and is refused as retiring, while the other lifecycle's join completes",
    /is retiring/.test(cOutcome) && bOutcome === "ok", { cOutcome, bOutcome });
  check("the broker holds 0 rows of the queued join's lifecycle and 1 of the other", (await rowsOf(c)).length === 0 && (await rowsOf(b)).length === 1);

  // The real deprovisioner purges the listed keys and retires the ACL row: nothing of the lifecycle stays.
  const listed = (listing.data as { channels: string[] }).channels;
  const dpv = await mintCreds(auth, newIdentity(), "deprovisioner", { deprovisionTarget: { principal: a.id.id, lifecycleUid: a.uid, memberChannels: listed } });
  await deprovisionAgent({ servers: broker.servers, space, targetId: a.id.id, lifecycleUid: a.uid, memberChannels: listed, creds: dpv });
  check("after the deprovisioner purged the listed keys, the retired lifecycle has 0 rows on the broker", (await rowsOf(a)).length === 0, await rowsOf(a));
  // The alias's next lifecycle retires in turn: its inventory drops the mark of the earlier one.
  const a2 = await seat("seat-a", a.id);
  await a2.ep.durableJoinChannel("lane.a");
  const a2Listing = await inventory({ principal: a2.principal, uid: a2.uid });
  const marks = [...(dj.retiringLifecycles.get(a.principal) ?? [])];
  check("the next lifecycle's inventory lists its row and keeps only its own mark for the alias",
    exact(a2Listing, ["lane.a"]) && marks.length === 1 && marks[0] === a2.uid, { a2Listing, marks });
} catch (e) {
  check(`suite ran without throwing: ${(e as Error).stack ?? (e as Error).message}`, false);
} finally {
  await caller?.stop().catch(() => {});
  for (const ep of endpoints) await ep.stop().catch(() => {});
  await writer?.close().catch(() => {});
  await daemon?.stop().catch(() => {});
  await broker.stop();
  rmSync(ws, { recursive: true, force: true });
}
finish();
process.exit(process.exitCode ?? 0);
