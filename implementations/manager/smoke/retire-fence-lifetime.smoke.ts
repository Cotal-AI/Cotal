/**
 * A retiring lifecycle gains no membership row after its inventory (#4984), against the real `Manager`'s
 * retirement broker phase (`deprovisionBroker`: ACL fence, `lifecycleMemberships` inventory, the
 * deprovisioner), the shipped delivery daemon (`_boot-delivery.ts`) and a JWT broker.
 *
 * The daemon's fence lived only in its memory and was checked before the row was written, so three
 * windows each kept one row of a retired lifecycle. The lifecycle's ACL row is now the first layer of
 * the fence: the manager narrows it before it asks for the inventory, and every join re-reads it around
 * the row it writes. The daemon's in-memory marks stay as the second layer, for a manager that does not
 * narrow. Each witness holds the shipped code at an existing await point and counts the retired
 * lifecycle's rows on the broker after the retirement:
 *   - PRUNE: a join whose ACL lookup already returned the lifecycle resumes after it was retired and
 *     its successor's inventory dropped the old mark;
 *   - RESTART: the daemon restarts between the inventory and the deprovisioner, and the seat's still
 *     open connection joins again;
 *   - HANDOVER: a quiesced predecessor finishes a join it took before its successor's inventory;
 *   - POSTWRITE: a quiesced predecessor's join passed its pre-write check and creates its row after the
 *     successor's inventory read, so only its post-write check can remove it;
 *   - TOMBSTONE: a quiesced predecessor's leave read the row before the deprovisioner purged it, and
 *     writes after the purge;
 *   - SKEW: a retirement that does not narrow (an older manager) against this daemon, with a late join
 *     on the same daemon process, which the in-memory mark refuses;
 *   - READFAIL: a predecessor's post-write ACL read fails, so it takes back only its own write, and a
 *     successor's retry that activated the still-authorized row keeps it until the lifecycle retires.
 * Every witness must end with 0 rows of the retired lifecycle.
 *
 * Run: pnpm smoke:retire-fence-lifetime (needs nats-server on PATH)
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CotalEndpoint, createSpaceAuth, deprovisionAgent, DEV_OWNER, liveKvEntries, memberKey, mintCreds, mintLifecycleUid, newIdentity, openAclRegistry,
  openMembersRegistry, parseMemberKey, principalKey, provisionAgent, readAcl, readMember, setupSpaceStreams, type ControlReply, type DeprovisionResourceAccounting, type Identity,
} from "@cotal-ai/core";
import { authDir, saveSpaceAuth, workspaceSecretStore } from "@cotal-ai/workspace";
import { createSuite } from "@cotal-ai/smoke-kit";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import type { KV } from "@nats-io/kv";
import { Manager } from "../src/manager.js";
import { bootBroker } from "./_boot-broker.js";
import { bootDeliveryDaemon } from "./_boot-delivery.js";

const { check, finish } = createSuite();
const uptime = () => execFileSync("uptime", { encoding: "utf8" }).trim();

for (const k of Object.keys(process.env)) if (k.startsWith("COTAL_")) delete process.env[k];
const space = `fencelife-${Math.random().toString(36).slice(2, 8)}`;
const dir = mkdtempSync(join(tmpdir(), "fence-lifetime-"));
const workspaceRoot = join(dir, "ws");
for (const d of [join(workspaceRoot, ".cotal"), join(dir, "home")]) mkdirSync(d, { recursive: true });
process.env.COTAL_HOME = join(dir, "home");
const seatRoot = (process.env.COTAL_SEAT_ROOT = mkdtempSync(join(tmpdir(), "s")));
process.env.DO_NOT_TRACK = "1";

const auth = await createSpaceAuth(space);
saveSpaceAuth(authDir(workspaceRoot), auth);
const broker = await bootBroker(auth);
const endpoints: CotalEndpoint[] = [];
let daemon: Awaited<ReturnType<typeof bootDeliveryDaemon>> | undefined;
const stale: Awaited<ReturnType<typeof bootDeliveryDaemon>>[] = [];
let manager: Manager | undefined;
let writer: Awaited<ReturnType<typeof connect>> | undefined;
const started = Date.now();
console.log(`start: ${uptime()}`);
try {
  await setupSpaceStreams({ servers: broker.servers, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  const boot = () => bootDeliveryDaemon({ space, servers: broker.servers, auth, reloadStoreIdentity: workspaceSecretStore(workspaceRoot).identity });
  daemon = await boot();
  manager = new Manager({ space, servers: broker.servers, runtime: "pty", workspaceRoot });
  await manager.start();
  const prov = new CotalEndpoint({ space, servers: broker.servers, creds: await mintCreds(auth, newIdentity(), "provisioner"), card: { name: "prov", kind: "endpoint" }, channels: [], consume: false, registerPresence: false, watchPresence: false, watchChannels: false });
  endpoints.push(prov);
  prov.on("error", () => {});
  await prov.start();
  const writerId = newIdentity();
  writer = await connect({ servers: broker.servers, inboxPrefix: `_INBOX_${writerId.id}`, authenticator: credsAuthenticator(new TextEncoder().encode(await mintCreds(auth, writerId, "delivery"))) });
  const kv = await openMembersRegistry(writer, space);
  const aclKv = await openAclRegistry(writer, space);

  const seat = async (name: string, id: Identity = newIdentity()) => {
    const uid = mintLifecycleUid();
    const creds = await provisionAgent(prov, auth, id, { subscribe: [], allowSubscribe: ["lane.>"], lifecycleUid: uid });
    const ep = new CotalEndpoint({ space, servers: broker.servers, creds, lifecycleUid: uid, card: { id: id.id, name, kind: "agent" }, channels: [], consume: false, registerPresence: false, watchPresence: false, watchChannels: false });
    endpoints.push(ep);
    ep.on("error", () => {});
    await ep.start();
    return { ep, id, uid, name, principal: principalKey(DEV_OWNER, id.id).key };
  };
  type Seat = Awaited<ReturnType<typeof seat>>;
  const rows = async (s: Seat) => (await liveKvEntries(kv)).map((e) => parseMemberKey(e.key)).filter((p) => p?.principal === s.principal && p.lifecycleUid === s.uid);
  const outcome = (p: Promise<unknown>) => p.then(() => "accepted", (e: Error) => e.message);
  const held = () => {
    let release!: () => void, entered!: () => void;
    const gate = { entered: new Promise<void>((r) => { entered = r; }), released: new Promise<void>((r) => { release = r; }) };
    return { ...gate, enter: () => entered(), release: () => release() };
  };

  // The manager's retirement broker phase, with each inventory it reads recorded and an optional step
  // run after that read and before the deprovisioner.
  const m = manager as unknown as {
    deprovisionBroker(a: { id: string; name: string; lifecycleUid: string }): Promise<DeprovisionResourceAccounting>;
    lifecycleMembershipInventory(a: { id: string; lifecycleUid: string }): Promise<{ complete: boolean; channels: string[]; reason?: string }>;
  };
  const readInventory = m.lifecycleMembershipInventory.bind(m);
  const listings = new Map<string, { complete: boolean; channels: string[]; fenced: boolean }>();
  let afterInventory: (() => Promise<void>) | undefined;
  m.lifecycleMembershipInventory = async (a) => {
    const acl = await readAcl(aclKv, principalKey(DEV_OWNER, a.id).key, a.lifecycleUid);
    const r = await readInventory(a);
    listings.set(a.lifecycleUid, { complete: r.complete, channels: r.channels, fenced: acl !== undefined && acl.record.allowSubscribe.length === 0 });
    const step = afterInventory;
    afterInventory = undefined;
    if (step) await step();
    return r;
  };
  const retire = (s: Seat) => m.deprovisionBroker({ id: s.id.id, name: s.name, lifecycleUid: s.uid });
  const listedOnly = (s: Seat, channels: string[]) => {
    const l = listings.get(s.uid);
    return l !== undefined && l.complete && l.fenced && JSON.stringify(l.channels) === JSON.stringify(channels);
  };
  let retained = 0;
  // Quiesce the serving daemon, release its lease at the exact revision, and boot a successor that
  // takes the lease. Returns the quiesced predecessor, still connected.
  const handover = async () => {
    const old = daemon!;
    await old.ep.quiescePlane3();
    const lease = await old.ep.readDeliveryLeaseEntry(0);
    if (!lease) throw new Error("the serving daemon's lease row is missing");
    await old.ep.releaseDeliveryLease(0, lease.revision);
    stale.push(old);
    daemon = await boot();
    return old;
  };
  const supervisor = (manager as unknown as { ep: { requestDeliveryAdmin(op: string, args: Record<string, unknown>, t?: number): Promise<ControlReply> } }).ep;

  // PRUNE: the ACL lookup of a join has returned the lifecycle when the join is held.
  {
    const t0 = Date.now();
    const a = await seat("prune-a");
    await a.ep.durableJoinChannel("lane.a");
    const d = daemon.ep as unknown as { aclForAlias(p: string): Promise<{ allowSubscribe: string[]; lifecycleUid: string } | undefined>; retiringLifecycles: Map<string, Set<string>> };
    const lookup = d.aclForAlias.bind(d);
    const h = held();
    let armed = true;
    d.aclForAlias = async (p) => {
      const result = await lookup(p);
      if (p === a.principal && armed) { armed = false; h.enter(); await h.released; }
      return result;
    };
    const late = outcome(a.ep.durableJoinChannel("lane.late"));
    await h.entered;
    const accounting = await retire(a);
    // The alias's next lifecycle retires in turn: its inventory drops the old lifecycle's mark, whose
    // ACL row the deprovisioner retired.
    const a2 = await seat("prune-a", a.id);
    const a2Listing = await supervisor.requestDeliveryAdmin("lifecycleMemberships", { principal: a2.principal, lifecycleUid: a2.uid }, 30_000);
    const markRemoved = a2Listing.ok && d.retiringLifecycles.get(a.principal)?.has(a.uid) === false;
    h.release();
    const lateOutcome = await late;
    d.aclForAlias = lookup;
    const left = await rows(a);
    retained += left.length;
    check("PRUNE: the retirement fenced the ACL row before its inventory, which listed the 1 row then on the broker",
      listedOnly(a, ["lane.a"]) && accounting.members.deleted === 1, { listing: listings.get(a.uid), members: accounting.members });
    check("PRUNE: the successor's inventory dropped the old lifecycle's mark, and the held join then resumed and was refused without writing",
      markRemoved && /no longer within the read ACL/.test(lateOutcome), { markRemoved, lateOutcome });
    check("PRUNE: 0 rows of the retired lifecycle remain", left.length === 0, left);
    console.log(`PRUNE_WITNESS inventoryListed=${listings.get(a.uid)?.channels.length} oldMarkRemoved=${markRemoved} lateJoinAccepted=${lateOutcome === "accepted"} retainedOldRows=${left.length} ms=${Date.now() - t0}`);
  }

  // RESTART: a new daemon boots between the inventory and the deprovisioner; the seat stays connected.
  {
    const t0 = Date.now();
    const b = await seat("restart-b");
    await b.ep.durableJoinChannel("lane.a");
    let lateOutcome = "not run";
    afterInventory = async () => {
      await daemon!.stop();
      daemon = await boot();
      lateOutcome = await outcome(b.ep.durableJoinChannel("lane.after"));
    };
    const accounting = await retire(b);
    const left = await rows(b);
    retained += left.length;
    check("RESTART: the retirement fenced the ACL row before its inventory, which listed 1 row",
      listedOnly(b, ["lane.a"]) && accounting.members.deleted === 1, { listing: listings.get(b.uid), members: accounting.members });
    check("RESTART: the restarted daemon refused the still-connected seat's join against the fenced ACL row",
      /not within your read ACL \[\]/.test(lateOutcome), lateOutcome);
    check("RESTART: 0 rows of the retired lifecycle remain", left.length === 0, left);
    console.log(`RESTART_WITNESS inventoryListed=${listings.get(b.uid)?.channels.length} lateJoinAccepted=${lateOutcome === "accepted"} retainedRows=${left.length} ms=${Date.now() - t0}`);
  }

  // HANDOVER: the predecessor quiesces with a join inside its durable-join write.
  {
    const t0 = Date.now();
    const c = await seat("handover-c");
    await c.ep.durableJoinChannel("lane.a");
    const old = daemon;
    const oldEp = old.ep as unknown as { durableJoinFor(...args: unknown[]): Promise<unknown> };
    const joinFor = oldEp.durableJoinFor.bind(oldEp);
    const h = held();
    oldEp.durableJoinFor = async (...args) => {
      if (args[0] === c.principal && args[1] === "lane.after") { h.enter(); await h.released; }
      return joinFor(...args);
    };
    const late = outcome(c.ep.durableJoinChannel("lane.after"));
    await h.entered;
    await handover();
    const accounting = await retire(c);
    h.release();
    const lateOutcome = await late;
    const left = await rows(c);
    retained += left.length;
    check("HANDOVER: the successor answered the fenced inventory with the 1 row then on the broker",
      old.ep.plane3IsQuiesced() && listedOnly(c, ["lane.a"]) && accounting.members.deleted === 1, { listing: listings.get(c.uid), members: accounting.members });
    check("HANDOVER: the quiesced predecessor's held join was refused without writing", /no longer within the read ACL/.test(lateOutcome), lateOutcome);
    check("HANDOVER: 0 rows of the retired lifecycle remain", left.length === 0, left);
    console.log(`HANDOVER_WITNESS oldQuiesced=${old.ep.plane3IsQuiesced()} inventoryListed=${listings.get(c.uid)?.channels.length} lateJoinAccepted=${lateOutcome === "accepted"} retainedRows=${left.length} ms=${Date.now() - t0}`);
  }

  // POSTWRITE: a predecessor's join passed its pre-write ACL read; its create lands after the
  // successor's inventory read. The predecessor's own inventory would have waited for it, so the
  // window is a daemon that no longer serves the shard.
  {
    const t0 = Date.now();
    const e = await seat("postwrite-e");
    await e.ep.durableJoinChannel("lane.a");
    const members = await (daemon.ep as unknown as { membersRegistry(): Promise<KV> }).membersRegistry();
    const create = members.create.bind(members);
    const key = memberKey("lane.after", e.principal, e.uid);
    const h = held();
    members.create = async (k, data, ...rest) => {
      if (k === key) { h.enter(); await h.released; }
      return create(k, data, ...rest);
    };
    const late = outcome(e.ep.durableJoinChannel("lane.after"));
    await h.entered;
    const old = await handover();
    let lateOutcome = "not settled";
    let lastOp: string | undefined;
    afterInventory = async () => {
      h.release();
      lateOutcome = await late;
      lastOp = (await kv.get(key))?.operation;
    };
    const accounting = await retire(e);
    members.create = create;
    const left = await rows(e);
    retained += left.length;
    check("POSTWRITE: the successor's fenced inventory listed only the 1 row on the broker before the held create",
      old.ep.plane3IsQuiesced() && listedOnly(e, ["lane.a"]) && accounting.members.deleted === 1, { listing: listings.get(e.uid), members: accounting.members });
    check("POSTWRITE: the create landed after the inventory read, and its post-write ACL read removed the row and refused the join",
      /narrowed or retired while the row was written; its "lane.after" row was removed/.test(lateOutcome) && lastOp === "PURGE", { lateOutcome, lastOp });
    check("POSTWRITE: 0 rows of the retired lifecycle remain", left.length === 0, left);
    console.log(`POSTWRITE_WITNESS inventoryListed=${listings.get(e.uid)?.channels.length} rowWrittenAfterInventory=${lastOp === "PURGE"} lateJoinAccepted=${lateOutcome === "accepted"} retainedRows=${left.length} ms=${Date.now() - t0}`);
  }

  // DEATH (#4994): a predecessor's join passed its pre-write ACL read, its create lands after the
  // successor's inventory read, and the daemon dies before its post-write ACL read. No check of the
  // join removes that row. The next message fanned out on the channel reaches the retired lifecycle's
  // inbox, and the reader that drops that entry removes the row with it.
  {
    const t0 = Date.now();
    const d = await seat("death-d");
    await d.ep.durableJoinChannel("lane.a");
    // The publisher whose message fans out after the retirement (a seat's post ACL is default-deny).
    const pId = newIdentity();
    const pUid = mintLifecycleUid();
    const p = new CotalEndpoint({ space, servers: broker.servers, creds: await provisionAgent(prov, auth, pId, { subscribe: [], allowSubscribe: ["lane.>"], allowPublish: ["lane.after"], lifecycleUid: pUid }), lifecycleUid: pUid, card: { id: pId.id, name: "death-p", kind: "agent" }, channels: [], consume: false, registerPresence: false, watchPresence: false, watchChannels: false });
    endpoints.push(p);
    p.on("error", () => {});
    await p.start();
    const oldEp = daemon.ep as unknown as { aclAllows(o: string, u: string, c: string): Promise<boolean>; membersRegistry(): Promise<KV> };
    const members = await oldEp.membersRegistry();
    const create = members.create.bind(members);
    const key = memberKey("lane.after", d.principal, d.uid);
    const h = held();
    members.create = async (k, data, ...rest) => {
      if (k === key) { h.enter(); await h.released; }
      return create(k, data, ...rest);
    };
    // The daemon dies before its post-write read: that read never answers while the witness runs.
    const allows = oldEp.aclAllows.bind(oldEp);
    let dies!: () => void;
    const death = new Promise<boolean>((r) => { dies = () => r(false); });
    let reads = 0;
    oldEp.aclAllows = async (o, u, c) => {
      if (o === d.principal && c === "lane.after" && ++reads === 2) return death;
      return allows(o, u, c);
    };
    const late = outcome(d.ep.durableJoinChannel("lane.after"));
    await h.entered;
    await handover();
    let rowAfterCreate: string | undefined;
    afterInventory = async () => {
      h.release();
      for (let i = 0; i < 50 && rowAfterCreate === undefined; i++) {
        rowAfterCreate = (await kv.get(key))?.operation;
        if (rowAfterCreate === undefined) await new Promise((r) => setTimeout(r, 100));
      }
    };
    const accounting = await retire(d);
    members.create = create;
    const leftBefore = await rows(d);
    check("DEATH: the successor's fenced inventory listed only the 1 row on the broker, and the held create landed after it",
      listedOnly(d, ["lane.a"]) && accounting.members.deleted === 1 && rowAfterCreate === "PUT", { listing: listings.get(d.uid), members: accounting.members, rowAfterCreate });
    check("DEATH: with the post-write read dead, 1 row of the retired lifecycle is left on the broker", leftBefore.length === 1, leftBefore);
    await p.multicast("after the retirement", { channel: "lane.after" });
    let left = await rows(d);
    for (let i = 0; i < 100 && left.length !== 0; i++) { await new Promise((r) => setTimeout(r, 100)); left = await rows(d); }
    retained += left.length;
    check("DEATH: the message fanned out against that row, and the reader that dropped its entry removed the row: 0 rows remain", left.length === 0, left);
    dies();
    const lateOutcome = await late;
    oldEp.aclAllows = allows;
    check("DEATH: the dead daemon's join, had it lived, would have refused without recreating the row", /narrowed or retired while the row was written/.test(lateOutcome) && (await rows(d)).length === 0, lateOutcome);
    console.log(`DEATH_WITNESS rowLeftByDeath=${leftBefore.length} retainedRows=${left.length} ms=${Date.now() - t0}`);
  }

  // TOMBSTONE: a predecessor's leave read the row; the deprovisioner purges it; then the leave writes.
  {
    const t0 = Date.now();
    const f = await seat("tombstone-f");
    const joined = await f.ep.durableJoinChannel("lane.a");
    const members = await (daemon.ep as unknown as { membersRegistry(): Promise<KV> }).membersRegistry();
    const update = members.update.bind(members);
    const key = memberKey("lane.a", f.principal, f.uid);
    const h = held();
    let armed = true;
    members.update = async (k, data, version, ...rest) => {
      if (k === key && armed) { armed = false; h.enter(); await h.released; }
      return update(k, data, version, ...rest);
    };
    const leave = outcome(f.ep.durableLeaveChannel("lane.a", joined.generation));
    await h.entered;
    await handover();
    const accounting = await retire(f);
    h.release();
    const leaveOutcome = await leave;
    members.update = update;
    const left = await rows(f);
    retained += left.length;
    check("TOMBSTONE: the successor's fenced inventory listed the row the leave had read, and the deprovisioner purged it",
      listedOnly(f, ["lane.a"]) && accounting.members.deleted === 1, { listing: listings.get(f.uid), members: accounting.members });
    check("TOMBSTONE: the leave's write after the purge recreated nothing", leaveOutcome === "accepted" && (await kv.get(key))?.operation === "PURGE", leaveOutcome);
    check("TOMBSTONE: 0 rows of the retired lifecycle remain", left.length === 0, left);
    console.log(`TOMBSTONE_WITNESS inventoryListed=${listings.get(f.uid)?.channels.length} leaveAccepted=${leaveOutcome === "accepted"} retainedRows=${left.length} ms=${Date.now() - t0}`);
  }

  // SKEW: a manager that does not narrow (the protocol before this fence) retires a lifecycle against
  // this daemon: the inventory, then the deprovisioner, with a late join on the same daemon process.
  {
    const t0 = Date.now();
    const g = await seat("skew-g");
    await g.ep.durableJoinChannel("lane.a");
    const listing = await supervisor.requestDeliveryAdmin("lifecycleMemberships", { principal: g.principal, lifecycleUid: g.uid }, 30_000);
    const acl = await readAcl(aclKv, g.principal, g.uid);
    const lateOutcome = await outcome(g.ep.durableJoinChannel("lane.late"));
    const channels = (listing.data as { channels?: string[] } | undefined)?.channels ?? [];
    const creds = await mintCreds(auth, newIdentity(), "deprovisioner", { deprovisionTarget: { principal: g.id.id, lifecycleUid: g.uid, memberChannels: channels } });
    const accounting = await deprovisionAgent({ servers: broker.servers, space, targetId: g.id.id, lifecycleUid: g.uid, memberChannels: channels, creds });
    const left = await rows(g);
    retained += left.length;
    check("SKEW: without a narrowing, the inventory listed the 1 row while the ACL row still allowed reads",
      listing.ok && JSON.stringify(channels) === JSON.stringify(["lane.a"]) && acl?.record.allowSubscribe.join() === "lane.>" && accounting.members.deleted === 1,
      { listing, acl: acl?.record.allowSubscribe, members: accounting.members });
    check("SKEW: a late join on the same daemon process is refused by the lifecycle's in-memory mark", /is retiring/.test(lateOutcome), lateOutcome);
    check("SKEW: 0 rows of the retired lifecycle remain", left.length === 0, left);
    const marks = (daemon.ep as unknown as { retiringLifecycles: Map<string, Set<string>> }).retiringLifecycles;
    check("SKEW: the daemon keeps its mark for the lifecycle the unfenced inventory named (#4996)", marks.get(g.principal)?.has(g.uid) === true, [...marks.entries()].map(([p, s]) => [p, [...s]]));
    console.log(`SKEW_WITNESS narrowed=false inventoryListed=${channels.length} lateJoinAccepted=${lateOutcome === "accepted"} retainedRows=${left.length} ms=${Date.now() - t0}`);
  }
  // FENCED (#4996): a manager that narrows the ACL row before its inventory needs no mark on the
  // daemon: the row every join re-reads around its write refuses the late join by itself. Without
  // this, each retired alias that never retires again kept one entry per space lane until the daemon
  // restarted.
  {
    const t0 = Date.now();
    const f = await seat("fenced-f");
    await f.ep.durableJoinChannel("lane.a");
    const marks = (daemon.ep as unknown as { retiringLifecycles: Map<string, Set<string>> }).retiringLifecycles;
    const accounting = await retire(f);
    const marked = marks.get(f.principal)?.has(f.uid) === true;
    const lateOutcome = await outcome(f.ep.durableJoinChannel("lane.late"));
    const left = await rows(f);
    retained += left.length;
    check("FENCED: the retirement fenced the ACL row before its inventory, which listed the 1 row", listedOnly(f, ["lane.a"]) && accounting.members.deleted === 1, { listing: listings.get(f.uid), members: accounting.members });
    check("FENCED: the daemon keeps no mark for a lifecycle whose inventory came fenced", !marked, [...marks.entries()].map(([p, s]) => [p, [...s]]));
    check("FENCED: a late join on the same daemon process is refused by the ACL row, not by a mark", /no read ACL on record|no longer within the read ACL|narrowed or retired/.test(lateOutcome) && !/is retiring/.test(lateOutcome), lateOutcome);
    check("FENCED: 0 rows of the retired lifecycle remain", left.length === 0, left);
    console.log(`FENCED_WITNESS marked=${marked} lateJoinAccepted=${lateOutcome === "accepted"} retainedRows=${left.length} ms=${Date.now() - t0}`);
  }
  // READFAIL: a predecessor's post-write ACL read fails and its removal of the row it wrote is held.
  // A successor takes a retry of the same join for the still-authorized lifecycle and activates that
  // row. The predecessor then takes back only its own revision, so the activated row stays.
  {
    const t0 = Date.now();
    const r = await seat("readfail-r");
    const oldEp = daemon.ep as unknown as { aclAllows(o: string, u: string, c: string): Promise<boolean>; membersRegistry(): Promise<KV> };
    const allows = oldEp.aclAllows.bind(oldEp);
    let reads = 0;
    oldEp.aclAllows = async (o, u, c) => {
      if (o === r.principal && c === "lane.r" && ++reads === 2) throw new Error("injected: the post-write ACL read failed");
      return allows(o, u, c);
    };
    const members = await oldEp.membersRegistry();
    const purge = members.purge.bind(members);
    const key = memberKey("lane.r", r.principal, r.uid);
    const h = held();
    members.purge = async (k, ...rest) => {
      if (k === key) { h.enter(); await h.released; }
      return purge(k, ...rest);
    };
    const first = outcome(r.ep.durableJoinChannel("lane.r"));
    await h.entered;
    await handover();
    const retry = await r.ep.durableJoinChannel("lane.r");
    h.release();
    const firstOutcome = await first;
    oldEp.aclAllows = allows;
    members.purge = purge;
    const kept = await readMember(kv, "lane.r", r.principal, r.uid);
    const liveRows = (await rows(r)).length;
    check("READFAIL: the predecessor refused its join and left the row a later write replaced",
      /could not be re-read after the row was written \(injected: the post-write ACL read failed\); a later write replaced its "lane\.r" row/.test(firstOutcome), firstOutcome);
    check("READFAIL: the successor's retry is durable and its 1 activated row stays while the lifecycle is authorized",
      retry.durable === true && liveRows === 1 && kept?.record.activated === true && kept.record.leaveCursor === undefined, { retry, liveRows, kept: kept?.record });
    const accounting = await retire(r);
    const left = await rows(r);
    retained += left.length;
    check("READFAIL: the lifecycle's retirement then lists and removes that row: 0 rows remain",
      listedOnly(r, ["lane.r"]) && accounting.members.deleted === 1 && left.length === 0, { listing: listings.get(r.uid), members: accounting.members, left });
    console.log(`READFAIL_WITNESS liveRowsKept=${liveRows} retryDurable=${retry.durable} retainedRows=${left.length} ms=${Date.now() - t0}`);
  }
  console.log(`FENCE_LIFETIME retainedRowWitnesses=${retained}`);
  check("every witness retired its lifecycle with 0 rows left", retained === 0, { retained });
} catch (e) {
  check(`suite ran without throwing: ${(e as Error).stack ?? (e as Error).message}`, false);
} finally {
  console.log(`end: ${uptime()} elapsedMs=${Date.now() - started}`);
  await manager?.stop().catch(() => {});
  for (const ep of endpoints) await ep.stop().catch(() => {});
  await writer?.close().catch(() => {});
  for (const d of stale) await d.stop().catch(() => {});
  await daemon?.stop().catch(() => {});
  await broker.stop();
  rmSync(dir, { recursive: true, force: true });
  rmSync(seatRoot, { recursive: true, force: true });
}
finish();
process.exit(process.exitCode ?? 0);
