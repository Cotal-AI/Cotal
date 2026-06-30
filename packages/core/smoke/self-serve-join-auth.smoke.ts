/**
 * Self-serve channel-join smoke (SPEC v0.3 overlay). Two phases:
 *
 *  Phase 1 — NO delivery daemon serving Plane-3: an auth-mode agent joins a channel's live feed at
 *  runtime and receives the live message via its native core subscription (broker-enforced by sub.allow).
 *  Join reports `durable:false` (joined live, backstop unestablished — no daemon); out-of-ACL join is
 *  refused (broker-confirmed); a core-sub leave stops delivery; the live read survives a broker
 *  reconnect. Daemon-free, so there is no durable backstop to establish or tombstone.
 *
 *  Phase 2 — a real Plane-3 host is present (the server-side delivery daemon: fan-out + trusted reader +
 *  the durableJoin/durableLeave/listMemberships ops it serves on `ctl.delivery`). A runtime join now also
 *  arms a Plane-3 backstop (`durable:true`), delivered alongside the live core-sub copy (the connector's
 *  id-dedup coalesces to exactly once — proven in cross-path-dedup). A runtime leave tombstones the §7
 *  boundary. And a BOOT durable membership — established by the agent's SELF-JOIN at connect (v3, not
 *  written at provision) — seeds the agent's leave mirror, so leaving the boot channel tombstones it too.
 *
 * Run: pnpm smoke:self-serve-join:auth   (needs `nats-server` on PATH; auth/JetStream, local-only)
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
  channelInAllow,
  openMembersRegistry,
  commitMember,
  readMember,
  CONTROL_SELF_SERVICE,
  type Delivery,
} from "../src/index.js";

// Fresh random port per run + await-exit on every broker kill (below): a fixed port plus a SIGKILL
// that doesn't await the child's exit leaks the broker, and the next run collides with the squatter
// (the "Authorization Violation" contamination reviewers hit). The mid-test reconnect restart reuses
// THIS port, so it too must await the old process's exit before respawning, or it races the dying one.
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
let pass = 0,
  fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}`, extra ?? "");
  }
};

const space = `selfjoin-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), "cotal-selfjoin-"));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, { port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
let server = srv; // mutable: the reconnect test restarts the broker and tracks the live process

try {
  let up = false;
  for (let i = 0; i < 50; i++) {
    if (await isReachable(SERVERS)) {
      up = true;
      break;
    }
    await wait(200);
  }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);

  // Privileged endpoint: provisions durables + publishes (and, in phase 2, serves the control plane).
  // Until then it is a BARE endpoint that does NOT serve control, so runtime joins have no responder.
  const mgrCreds = await mintCreds(auth, newIdentity(), "manager");
  await setupSpaceStreams({ servers: SERVERS, space, creds: mgrCreds });
  const pub = new CotalEndpoint({
    space,
    servers: SERVERS,
    creds: mgrCreds,
    card: { name: "pub", kind: "endpoint" },
    consume: false,
    registerPresence: false,
    watchPresence: false,
    heartbeatMs: 300,
    ttlMs: 1500,
  });
  pub.on("error", (e: Error) => console.error("  ! pub", e.message));
  await pub.start();

  // Agent A: boots subscribed to ["general","ops"] (durable pre-created over both), read ACL also
  // covers review.> (so it can self-serve runtime joins under that subtree) but NOT "secret".
  const aId = newIdentity();
  const aCreds = await provisionAgent(pub, auth, aId, {
    subscribe: ["general", "ops"],
    allowSubscribe: ["general", "ops", "review.>"],
  });
  const a = new CotalEndpoint({
    space,
    servers: SERVERS,
    creds: aCreds,
    card: { id: aId.id, name: "alice", kind: "agent" },
    channels: ["general", "ops"],
    heartbeatMs: 500,
    ttlMs: 2000,
  });
  const got: string[] = [];
  const gotDurable: string[] = []; // keys delivered with durable:true (the Plane-3 backstop copy)
  a.on("message", (m, d: Delivery) => {
    const key = `#${m.channel}:${m.parts.map((p) => (p.kind === "text" ? p.text : "")).join("")}`;
    got.push(key);
    if (d.durable) gotDurable.push(key);
    d.ack();
  });
  a.on("error", (e: Error) => console.error("  ! alice:", e.message));
  await a.start();
  await wait(500);

  // ───────────────────── Phase 1 — NO control responder (manager-free) ─────────────────────
  const r = await a.joinChannel("review.api");
  check("manager-free joinChannel(review.api) succeeds", r.joined === true, r);
  check("manager-free join reports durable:false (joined live, backstop unestablished)", r.durable === false, r);

  await pub.multicast("live via core-sub", { channel: "review.api" });
  await wait(400);
  check(
    "manager-free join DELIVERS the live message (core-sub)",
    got.filter((g) => g === "#review.api:live via core-sub").length === 1,
    got,
  );

  await pub.multicast("on general", { channel: "general" });
  await wait(400);
  check(
    "boot channel delivered via its core-sub, exactly once",
    got.filter((g) => g === "#general:on general").length === 1,
    got,
  );

  // Reconnect resilience: a manager-free core-sub join must SURVIVE a broker restart — the rebind has
  // to reopen the core subscription (reconcile off the durable's real filter), not leave it inert.
  server.kill("SIGKILL");
  await awaitExit(server); // the restart reuses PORT — the old broker must fully exit + free the socket first
  server = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
  let back = false;
  for (let i = 0; i < 50; i++) {
    if (await isReachable(SERVERS)) {
      back = true;
      break;
    }
    await wait(200);
  }
  if (!back) throw new Error("broker did not restart");
  await wait(3000); // reconnect + startConsumers rebind + core-sub reconciliation
  got.length = 0;
  await pub.multicast("after reconnect", { channel: "review.api" });
  await wait(800);
  check(
    "manager-free core-sub join SURVIVES a broker reconnect",
    got.some((g) => g === "#review.api:after reconnect"),
    got,
  );

  let joinDenied = false;
  try {
    await a.joinChannel("secret");
  } catch {
    joinDenied = true;
  }
  check("join out-of-ACL (secret) is refused (broker-confirmed)", joinDenied);

  // Core-sub leave is manager-free and stops delivery.
  await a.leaveChannel("review.api");
  got.length = 0;
  await pub.multicast("after leave", { channel: "review.api" });
  await wait(400);
  check("after manager-free leave, no live delivery", !got.some((g) => g.includes("after leave")), got);

  // Leaving a boot channel is now manager-free too (just closes the core-sub — there is no legacy
  // durable to refuse the leave). It stops delivery.
  const leftGeneral = await a.leaveChannel("general");
  check("leaving a boot channel succeeds (manager-free core-sub close)", leftGeneral.left === true, leftGeneral);
  got.length = 0;
  await pub.multicast("after general leave", { channel: "general" });
  await wait(300);
  check("after leaving the boot channel, no delivery", !got.some((g) => g.includes("after general leave")), got);

  // ───────────── Phase 2 — a real Plane-3 host: the delivery daemon (fan-out + trusted reader + ctl.delivery join/leave) ─────────────
  // Host Plane-3 on `pub` and serve the durableJoin/Leave ctl ops that joinChannel/leaveChannel now use
  // for a `durable`-class channel (the legacy filter-move is no longer the runtime durable path). The
  // trusted reader re-authorizes against the caller's current ACL (its allowSubscribe), supplied here.
  // Per-id read ACLs, shared by the reader (startPlane3) and the control responder. Faithful to the
  // real Manager (implementations/manager): durableJoin checks the caller's ACL, durableLeave REQUIRES
  // a finite generation (fail-closed stale-leave guard), and listMemberships serves the caller's own
  // current memberships so a connecting agent can hydrate its boot generations.
  const acls: Record<string, string[]> = { [aId.id]: ["general", "ops", "review.>"] };
  await pub.startPlane3((id) => acls[id]);
  pub.serveControl(CONTROL_SELF_SERVICE, async (req) => {
    const acl = acls[req.from.id];
    const args = req.args as { channel?: unknown; generation?: unknown };
    const ch = typeof args?.channel === "string" ? args.channel : "";
    if (req.op === "listMemberships") return { ok: true, data: { memberships: await pub.ownerMemberships(req.from.id) } };
    if (req.op === "durableJoin") {
      if (!ch || !acl || !channelInAllow(acl, ch)) return { ok: false, error: `not in ACL: ${ch}` };
      return { ok: true, data: await pub.durableJoinFor(req.from.id, ch) };
    }
    if (req.op === "durableLeave") {
      if (typeof args?.generation !== "number") return { ok: false, error: "durableLeave: a finite generation is required (fail-closed)" };
      await pub.durableLeaveFor(req.from.id, ch, args.generation);
      return { ok: true, data: { channel: ch } };
    }
    return { ok: false, error: `unknown op: ${req.op}` };
  });
  await wait(200);

  got.length = 0;
  gotDurable.length = 0;
  const r2 = await a.joinChannel("review.db");
  check("manager-present joinChannel(review.db) succeeds", r2.joined === true, r2);
  check("manager-present join reports durable:true (Plane-3 backstop active)", r2.durable === true, r2);

  await pub.multicast("dual-path once", { channel: "review.db" });
  check(
    "the Plane-3 durable backstop delivers the durable copy (next-turn, durable:true)",
    await until(() => gotDurable.includes("#review.db:dual-path once")),
    { got, gotDurable },
  );
  // The channel ALSO arrives live via the core-sub (durable:false) — Plane-3 channels are dual-path at
  // the endpoint; the CONNECTOR's commit-aware id-dedup (MeshAgent.ingest) collapses the two emits to
  // one. That exactly-once coalescing is proven in cross-path-dedup.smoke (a raw endpoint can't dedup).
  check("...and the live wake-hint copy arrives too (dual-path)", got.filter((g) => g === "#review.db:dual-path once").length >= 1, got);

  // Plane-3 leave tombstones membership at the leave cursor: a post AFTER leave is denied by the
  // backstop (seq > leaveCursor) AND the core-sub is closed — nothing arrives by either path.
  await a.leaveChannel("review.db");
  got.length = 0;
  gotDurable.length = 0;
  await pub.multicast("gone", { channel: "review.db" });
  await wait(900);
  check("manager-present leave stops delivery (core-sub closed + backstop tombstoned)", !got.some((g) => g.includes("gone")), got);

  // ── BOOT durable LEAVE via ON-DEMAND re-resolution (v3): alice's boot "ops" membership is established
  //    by her self-join via the daemon. Below we force its mirror entry to a pending/missing state, so
  //    leaving "ops" must STILL tombstone — leaveChannel re-resolves the generation from the delivery
  //    service on demand (fail-closed), so a missing mirror entry is not a silent §7 fail-open.
  // alice self-joined "ops" in Phase 1 (no daemon yet); the daemon reconciles that boot membership
  // only after it comes up in Phase 2, so POLL for it rather than assume the elapsed review.db steps
  // were enough — a slow round-trip (CI/Windows) lagged it and flaked this check (cf. the `until`
  // wait the durable-delivery check above uses for the same eventual-consistency reason).
  let aliceOpsBefore = await pub.channelMembers("ops");
  for (let i = 0; i < 160 && !aliceOpsBefore.some((m) => m.id === aId.id); i++) {
    await wait(50);
    aliceOpsBefore = await pub.channelMembers("ops");
  }
  check("alice's boot 'ops' membership is present (self-joined at connect)", aliceOpsBefore.some((m) => m.id === aId.id), aliceOpsBefore);

  // Force alice's "ops" record to a crash-stuck PENDING activation (activated:false). It still routes
  // (pure-interval durableEligible) but is hidden from channelMembers + the hydration mirror — so
  // leaveChannel must still DISCOVER it via ownerMemberships (which returns non-activated records) and
  // TOMBSTONE it (the engineer/critic BLOCKER-1 leave-discovery gap), exercised end-to-end.
  const kvNc = await connect({ servers: SERVERS, authenticator: credsAuthenticator(new TextEncoder().encode(mgrCreds)), inboxPrefix: "_INBOX_kv", maxReconnectAttempts: 0 });
  kvNc.on?.("error", () => {});
  const kv = await openMembersRegistry(kvNc, space);
  const opsRec = (await readMember(kv, "ops", aId.id))!.record;
  await commitMember(kv, { ...opsRec, activated: false });
  const hidden = await pub.channelMembers("ops");
  check("an activation-pending (activated:false) member is HIDDEN from channelMembers", !hidden.some((m) => m.id === aId.id), hidden);

  const opsLeave = await a.leaveChannel("ops");
  check("leaving an UN-hydrated, activation-pending boot durable channel succeeds (generation re-resolved on demand)", opsLeave.left === true, opsLeave);
  await wait(150);
  const opsRecAfter = await readMember(kv, "ops", aId.id);
  check("leave TOMBSTONES the activation-pending record (discovered despite activated:false — BLOCKER-1 leave-discovery)", opsRecAfter?.record.leaveCursor !== undefined, opsRecAfter?.record);
  await kvNc.close();
  got.length = 0;
  await pub.multicast("after ops leave", { channel: "ops" });
  await wait(900); // settle: prove ABSENCE — both planes closed
  check("after the un-hydrated boot leave, no delivery (live sub closed + backstop tombstoned)", !got.some((g) => g.includes("after ops leave")), got);

  // ── BOOT durable LEAVE via the self-join mirror (v3): bob boots on "ops" (durable) WITH the delivery
  //    daemon present, so his boot self-join establishes the membership and seeds its generation in the
  //    mirror (plane3Channels). Leaving "ops" then tombstones the §7 boundary from that mirror — and if
  //    the mirror entry were missing, leaveChannel re-resolves the generation on demand (fail-closed).
  const bId = newIdentity();
  acls[bId.id] = ["ops"];
  const bCreds = await provisionAgent(pub, auth, bId, { subscribe: ["ops"], allowSubscribe: ["ops"] });
  const b = new CotalEndpoint({
    space, servers: SERVERS, creds: bCreds,
    card: { id: bId.id, name: "bob", kind: "agent" },
    channels: ["ops"], heartbeatMs: 500, ttlMs: 2000,
  });
  const gotB: string[] = [];
  b.on("error", () => {});
  b.on("message", (m, d: Delivery) => { gotB.push(`#${m.channel}:${m.parts.map((p) => (p.kind === "text" ? p.text : "")).join("")}`); d.ack(); });
  await b.start();

  // Poll for bob's boot self-join to hydrate (connect + daemon round-trip) rather than assume a fixed
  // delay — same eventual-consistency flake class as alice's check above; a fixed wait can lag on CI/Windows.
  let bootMembers = await pub.channelMembers("ops");
  for (let i = 0; i < 160 && !bootMembers.some((m) => m.id === bId.id); i++) {
    await wait(50);
    bootMembers = await pub.channelMembers("ops");
  }
  check("bob's BOOT durable membership is listed (activated, hydrated)", bootMembers.some((m) => m.id === bId.id), bootMembers);

  const bootLeave = await b.leaveChannel("ops");
  check("leaving a BOOT durable channel succeeds (hydrated generation → fail-closed tombstone)", bootLeave.left === true, bootLeave);
  await wait(150);
  const afterBootLeave = await pub.channelMembers("ops");
  check("a boot-channel leave TOMBSTONES its Plane-3 membership (no longer a member)", !afterBootLeave.some((m) => m.id === bId.id), afterBootLeave);
  gotB.length = 0;
  await pub.multicast("after boot leave", { channel: "ops" });
  await wait(900); // settle: prove ABSENCE — both planes closed (live sub + backstop)
  check("after a boot-channel leave the backstop stops too (§7 hard boundary, both planes)", !gotB.some((g) => g.includes("after boot leave")), gotB);

  await b.stop();
  await a.stop();
  await pub.stop();
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).message);
} finally {
  server.kill("SIGKILL");
  await awaitExit(server); // await actual exit so a failed run never leaks the broker onto its port
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\nSELF-SERVE-JOIN SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
