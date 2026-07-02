/**
 * Plane-3 ACTIVATION honesty (Stage-4 round-2 panel blockers) against a REAL auth broker.
 *
 * Closes the blocker set the panel found on the first Stage-4 freeze:
 *
 *  (1) ACTIVATION RACE — `durableEligible` is now a PURE-INTERVAL delivery predicate, INDEPENDENT of
 *      `activated`. A `durable-active` record still completing catch-up (`activated:false`) routes
 *      in-interval immediately, so neither the trusted reader ack-drops catch-up dinbox entries (Leak A)
 *      nor does fan-out skip post-fence/pre-activation messages (Leak B). We prove BOTH at once: an
 *      `activated:false` in-interval member RECEIVING a post is only possible if fan-out ROUTED it
 *      (else no dinbox entry — Leak B) AND the reader TRANSFERRED it (else ack-dropped — Leak A).
 *      Mutation: re-add `if (!rec.activated) return false` to durableEligible and this goes red.
 *  (2) channelMembers HONESTY — the observability surface lists only ACTIVATED, non-tombstoned members.
 *      An activation-pending (or failed) join reported durable:false must not surface as a member.
 *  (3) BOOT MEMBERSHIP via SELF-JOIN (v3) — the manager records only the read-ACL at provision; the
 *      AGENT self-joins its durable boot channels via the daemon's `ctl.delivery` op at connect (no
 *      manager-written provision-time membership). Proven by channelMembers('general') listing the boot
 *      member AFTER alice connects + self-joins.
 *
 * Run: pnpm smoke:plane3-activation:auth   (needs `nats-server` on PATH; auth/JetStream, local-only)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import {
  CotalEndpoint,
  isReachable,
  createSpaceAuth,
  mintCreds,
  provisionAgent,
  serverConfig,
  newIdentity,
  setupSpaceStreams,
  openMembersRegistry,
  commitMember,
  type MembershipRecord,
  type Delivery,
} from "../src/index.js";

const PORT = 20000 + Math.floor(Math.random() * 40000);
const SERVERS = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, timeoutMs = 8000, stepMs = 50): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) await wait(stepMs);
  return cond();
};
const awaitExit = (proc: ReturnType<typeof spawn>, timeoutMs = 3000): Promise<void> =>
  new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    proc.once("exit", () => resolve());
    setTimeout(resolve, timeoutMs);
  });
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

const space = `plane3act-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), "cotal-plane3act-"));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, { port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });

try {
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);

  const mgrId = newIdentity();
  const mgrCreds = await mintCreds(auth, mgrId, "provisioner");
  await setupSpaceStreams({ servers: SERVERS, space, creds: mgrCreds });
  const mgr = new CotalEndpoint({
    space, servers: SERVERS, creds: mgrCreds,
    card: { id: mgrId.id, name: "mgr", kind: "endpoint" },
    channels: [], consume: false, registerPresence: false, watchPresence: false,
  });
  mgr.on("error", (e: Error) => console.error("  ! mgr", e.message));
  await mgr.start();
  // Plane-3 host = the server-side delivery daemon (scoped `delivery` cred), NOT the
  // manager — the manager cred no longer carries the Plane-3 inject grants (closure (i)).
  // The manager stays provisioner + publisher (its multicast posts chat AS the operator;
  // the daemon's fan-out reads CHAT and delivers). Only the HOST endpoint moves here.
  const dlvId = newIdentity();
  const dlv = new CotalEndpoint({
    space, servers: SERVERS, creds: await mintCreds(auth, dlvId, "delivery"),
    card: { id: dlvId.id, name: "delivery", role: "delivery", kind: "endpoint" },
    channels: [], consume: false, registerPresence: false, watchPresence: true,
  });
  dlv.on("error", (e: Error) => console.error("  ! dlv", e.message));
  await dlv.start();

  // Agent boots subscribed to "general" (durable by default), read ACL also covers "review". (v3) The
  // manager records the read-ACL at provision but writes NO boot membership; the agent SELF-JOINS its
  // durable boot channels via the daemon's ctl.delivery op at connect — so channelMembers('general')
  // below lists alice only AFTER she connects (+ self-joins), which startPlane3 here serves.
  const aId = newIdentity();
  const aCreds = await provisionAgent(mgr, auth, aId, { subscribe: ["general"], allowSubscribe: ["general", "review"] });
  await dlv.startPlane3((id) => (id === aId.id ? ["general", "review"] : undefined));

  const a = new CotalEndpoint({
    space, servers: SERVERS, creds: aCreds,
    card: { id: aId.id, name: "alice", kind: "agent" },
    channels: ["general"], heartbeatMs: 500, ttlMs: 2000,
  });
  const got: string[] = [];
  a.on("error", () => {});
  a.on("message", (m, d: Delivery) => { got.push(m.parts.map((p) => (p.kind === "text" ? p.text : "")).join("")); d.ack(); });
  await a.start();
  await wait(400); // connect + boot-membership hydration round-trip

  // ───────────── (3) BOOT MEMBERSHIP via SELF-JOIN at connect (v3) ─────────────
  const genMembers = await mgr.channelMembers("general");
  check(
    "boot durable membership is established by the agent's self-join at connect (v3 — no provision-time write)",
    genMembers.some((m) => m.id === aId.id),
    genMembers,
  );
  // ...a launcher that opts out of durable (durableMembership:false — direct `cotal spawn`) gets NO ACL
  // row, so even if it connected the daemon would refuse its self-join — and here it never connects, so
  // it never appears as a durable member (live-only).
  const ghostId = newIdentity();
  await provisionAgent(mgr, auth, ghostId, { subscribe: ["general"], allowSubscribe: ["general"], durableMembership: false });
  const ghostMembers = await mgr.channelMembers("general");
  check(
    "a live-only launcher (durableMembership:false, never self-joined) is NOT a durable member",
    !ghostMembers.some((m) => m.id === ghostId.id),
    ghostMembers,
  );

  // ───────────── (1)+(2) ACTIVATION RACE + channelMembers honesty ─────────────
  // Plant an activation-PENDING record (durable-active, activated:false) for alice on "review", which
  // she does NOT live-subscribe — so the ONLY delivery path is fan-out → dinbox → reader → DLV.
  // joinCursor:0 ⇒ any new post is in-interval.
  // The members registry is the DELIVERY daemon's to write (closure (i): the manager cred no longer
  // holds a members-bucket grant). Plant the crafted record with a `delivery` cred (its own per-id inbox).
  const seedId = newIdentity();
  const kvNc = await connect({
    servers: SERVERS,
    authenticator: credsAuthenticator(new TextEncoder().encode(await mintCreds(auth, seedId, "delivery"))),
    inboxPrefix: `_INBOX_${seedId.id}`,
    maxReconnectAttempts: 0,
  });
  kvNc.on?.("error", () => {});
  const kv = await openMembersRegistry(kvNc, space);
  const pending: MembershipRecord = {
    channel: "review", owner: aId.id, state: "durable-active", joinCursor: 0,
    generation: 1, activated: false, writerIdentity: seedId.id, updatedAt: Date.now(),
  };
  await commitMember(kv, pending);

  const reviewPending = await mgr.channelMembers("review");
  check(
    "channelMembers HIDES an activation-pending (activated:false) member — surface never overstates",
    !reviewPending.some((m) => m.id === aId.id),
    reviewPending,
  );
  // ...but leave-discovery (ownerMemberships) DOES return it, so leaveChannel can close a non-activated
  // record that still routes under the pure-interval predicate (critic BLOCKER-1 leave-discovery gap).
  const pendingOwned = await mgr.ownerMemberships(aId.id);
  check(
    "ownerMemberships INCLUDES the activation-pending record (leaveChannel can discover + close it)",
    pendingOwned.some((m) => m.channel === "review" && m.activated === false),
    pendingOwned,
  );

  await mgr.multicast("activation-pending-delivers", { channel: "review" });
  check(
    "an activation-pending in-interval member RECEIVES the post via the backstop (fan-out ROUTED + reader TRANSFERRED on the interval, not on `activated` — closes both leaks)",
    await until(() => got.includes("activation-pending-delivers")),
    got,
  );

  // Flip to activated → now a confirmed, complete member.
  await commitMember(kv, { ...pending, activated: true, updatedAt: Date.now() });
  const reviewActive = await mgr.channelMembers("review");
  check(
    "channelMembers LISTS the member once activation completes (completeness honesty)",
    reviewActive.some((m) => m.id === aId.id),
    reviewActive,
  );
  await kvNc.close();

  await a.stop();
  await dlv.stop();
  await mgr.stop();
  console.log(`\nPLANE-3 ACTIVATION SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
} finally {
  srv.kill("SIGKILL");
  await awaitExit(srv);
  rmSync(dir, { recursive: true, force: true });
}
process.exit(fail === 0 ? 0 : 1);
