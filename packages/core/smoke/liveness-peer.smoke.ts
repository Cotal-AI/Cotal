/**
 * THE PEER-READABLE LIVENESS SURFACE, against a REAL auth broker (#1577).
 *
 * WHAT IS BEING PROVED, and why it needs a real broker rather than a unit test. The complaint is
 * that a credentialed NON-OWNER cannot ask whether a plane is alive, so every failure it sees
 * presents as a credential failure. The fix is therefore a PERMISSIONS fact as much as a logic one,
 * and permissions do not exist in an open mesh: a suite that ran one would pass while the shipped
 * grant refused every call in production. That has happened in this repository before (see
 * `manager-lease-grant.smoke.ts`), so every cell here runs under a real minted credential against a
 * real nats-server with auth on.
 *
 * THE INSTRUMENT MUST BE ABLE TO FAIL, which the reporter's evidence table is entirely about: six
 * surfaces reported success over a failure, one of them a `pgrep` that matched its own command line
 * and so failed in BOTH directions. So this suite is built to be falsifiable at every axis:
 *
 *   • the bound and unbound arms of each plane are the SAME probe under opposite conditions, one run
 *     apart. If the probe answered identically either way, both arms could not pass;
 *   • the unknown arm is reached by a condition that is neither (a responder that cannot grade
 *     itself), so a surface that folded unknown into either health state reds here;
 *   • the boundary cells have a positive CONTROL beside them: the same peer, the same connection,
 *     one call allowed and one refused. A refusal alone proves nothing, because a broken fixture is
 *     also refused everything.
 *
 * EVERY PROBE IS THE SHIPPED FUNCTION. `probeLiveness` is called on a real endpoint over a real
 * connection; nothing here re-implements the grading, because a re-implementation would grade the
 * copy rather than the code that ships.
 *
 * Needs `nats-server` on PATH. Run: pnpm smoke:liveness-peer
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
  mintLifecycleUid,
  serverConfig,
  newIdentity,
  setupSpaceStreams,
  standaloneConnectOpts,
  permissionsFor,
  DEV_OWNER,
  livenessSubject,
  livenessServeFilter,
  managerBucket,
  deliveryBucket,
  MANAGER_LEASE_KEY,
  responderFromProbe,
  parseLivenessAnswer,
  LIVENESS_PLANES,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal, emitSentinel } from "@cotal-ai/smoke-kit";

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const space = `liveness-${randomUUID().slice(0, 8)}`;

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra === undefined ? "" : JSON.stringify(extra)); }
};

const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);
process.on("exit", () => { try { srv.kill("SIGKILL"); } catch { /* gone */ } rmSync(dir, { recursive: true, force: true }); releaseBroker(); });

/** NATS subject matching, so a grant row is judged by what it AUTHORIZES rather than by how it is
 *  spelled: a wildcard row that does not contain the literal subject text still grants it. */
function subjectMatches(pattern: string, subject: string): boolean {
  const p = pattern.split(" ")[0].split("."), s = subject.split(".");
  for (let i = 0; i < p.length; i++) {
    if (p[i] === ">") return s.length > i;
    if (i >= s.length) return false;
    if (p[i] !== "*" && p[i] !== s[i]) return false;
  }
  return p.length === s.length;
}
const grants = (rows: string[], subject: string) => rows.some((r) => subjectMatches(r, subject));

/** The rows a profile actually mints, through the shipped builder. */
function rowsFor(profile: string, actor: string): { pub: string[]; sub: string[] } {
  const uid = mintLifecycleUid();
  const pr = { owner: DEV_OWNER, actor, connId: "conn0123456789abcdef", lifecycleUid: uid };
  const perms = permissionsFor(profile as Parameters<typeof permissionsFor>[0], space, pr as never, { lifecycleUid: uid } as never) as
    { pub?: { allow?: string[] }; sub?: { allow?: string[] } };
  return { pub: perms.pub?.allow ?? [], sub: perms.sub?.allow ?? [] };
}

/** Try a publish under a credential and report the BROKER's verdict, for the boundary cells where
 *  the question is what nats-server permits rather than what a handler chooses to answer.
 *
 *  IT MUST BE A `request`, NOT A BARE `publish`. nats-server delivers a publish permission violation
 *  ASYNCHRONOUSLY on the connection's status channel; `publish()` does not throw and `flush()`
 *  succeeds, so a detector built on them returns "allowed" for EVERY input — an instrument that
 *  cannot report the refusal it exists to detect. That is not hypothetical: the first version of this
 *  suite did exactly that, and its boundary cells "failed" while the grant under test was correct.
 *  `request` surfaces the violation as a thrown error, which is why the rest of this repository's
 *  authed fixtures use it. The D1/D2 and D3/D4 pairs below are the standing proof that the fixed
 *  detector discriminates: same credential, same call, opposite verdicts in one run. */
async function tryPublish(creds: string, id: string, subject: string): Promise<"allowed" | "denied"> {
  const nc = await connect({
    servers: SERVERS,
    authenticator: credsAuthenticator(new TextEncoder().encode(creds)),
    inboxPrefix: `_INBOX_${id}`,
    maxReconnectAttempts: 0,
  });
  try {
    await nc.request(subject, new Uint8Array(0), { timeout: 500 });
    return "allowed";
  } catch (e) {
    const m = (e as Error).message.toLowerCase();
    // A TIMEOUT means the publish was PERMITTED and simply went unanswered, which is "allowed" for
    // this question: the boundary being measured is the broker's, not whether anyone replied.
    return m.includes("authorization") || m.includes("permission") ? "denied" : "allowed";
  } finally {
    await nc.drain().catch(() => { /* already gone */ });
  }
}

/** Try a SUBSCRIBE under a credential and report the broker's verdict. A subscribe violation also
 *  arrives asynchronously — on the status channel and on the subscription callback — so both are
 *  watched and a grace window is waited out. Reading "no exception" as "allowed" is the same false
 *  green this whole issue is about. */
async function trySubscribe(creds: string, id: string, subject: string, graceMs = 400): Promise<"allowed" | "denied"> {
  const nc = await connect({
    servers: SERVERS,
    authenticator: credsAuthenticator(new TextEncoder().encode(creds)),
    inboxPrefix: `_INBOX_${id}`,
    maxReconnectAttempts: 0,
  });
  let denied = false;
  void (async () => {
    for await (const s of nc.status()) {
      const blob = `${(s as { type?: string }).type ?? ""} ${(s as { data?: unknown }).data ?? ""}`;
      if (/permission|authorization/i.test(blob)) denied = true;
    }
  })().catch(() => { /* connection closed */ });
  const sub = nc.subscribe(subject, { callback: (err) => { if (err) denied = true; } });
  await nc.flush().catch(() => { denied = true; });
  await new Promise((r) => setTimeout(r, graceMs));
  try { sub.unsubscribe(); } catch { /* ignore */ }
  await nc.drain().catch(() => { /* already gone */ });
  return denied ? "denied" : "allowed";
}

try {
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    if (await isReachable(SERVERS)) { up = true; break; }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!up) throw new Error(`fixture broker never came up on ${SERVERS} - refusing to report on a server that never started`);

  const mgrId = newIdentity();
  const setupCreds = await mintCreds(auth, mgrId, "provisioner");
  await setupSpaceStreams({ servers: SERVERS, space, creds: setupCreds });

  // The PROVISIONER endpoint, used only to mint the peer below.
  const mgr = new CotalEndpoint({
    space, servers: SERVERS, creds: setupCreds,
    card: { id: mgrId.id, name: "mgr", kind: "endpoint" },
    channels: [], consume: false, registerPresence: false, watchPresence: false,
  });
  mgr.on("error", (e: Error) => console.error("  ! mgr", e.message));
  await mgr.start();

  // ---------------------------------------------------------------------------------------------
  // THE PEER: an ordinary agent credential. It is NOT the owner of either plane, holds no manager
  // grant of any kind, and is the exact principal the issue says is unable to ask.
  // ---------------------------------------------------------------------------------------------
  const peerId = newIdentity();
  const peerUid = mintLifecycleUid();
  const peerCreds = await provisionAgent(mgr, auth, peerId, {
    subscribe: ["general"], allowSubscribe: ["general"], lifecycleUid: peerUid,
  });
  const peer = new CotalEndpoint({
    space, servers: SERVERS, creds: peerCreds,
    card: { id: peerId.id, name: "peer", kind: "endpoint" },
    channels: [], consume: false, registerPresence: false, watchPresence: false, lifecycleUid: peerUid,
  });
  peer.on("error", (e: Error) => console.error("  ! peer", e.message));
  await peer.start();

  // The fixture proves its own target before reporting on anything: being pointed at another broker
  // looks identical to being refused by this one.
  const probeNc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds: peerCreds, tls: false }), maxReconnectAttempts: 0 });
  check("CONTROL: the fixture is talking to ITS OWN broker, not whatever is on the default port",
    probeNc.info?.port === PORT, { got: probeNc.info?.port, want: PORT });
  await probeNc.drain().catch(() => { /* fine */ });

  // =============================================================================================
  console.log("\nCELL GROUP A - UNBOUND: no responder exists yet, and the peer is told so");
  // The probes below run BEFORE any responder binds. This ordering is the point: the state a peer
  // most needs to diagnose is the one where nothing is up, and it is the state a surface that only
  // came up alongside a healthy plane could never report.
  // =============================================================================================
  const mgrUnbound = await peer.probeLiveness("manager", 1_500);
  check("CELL A1: a non-owner peer probing the MANAGER plane with no responder gets `unbound`",
    mgrUnbound.responder === "unbound", mgrUnbound);
  const dlvUnbound = await peer.probeLiveness("delivery", 1_500);
  check("CELL A2: a non-owner peer probing the DELIVERY plane with no responder gets `unbound`",
    dlvUnbound.responder === "unbound", dlvUnbound);
  check("CELL A3: the answer names the plane it is about, so two probes cannot be confused",
    mgrUnbound.plane === "manager" && dlvUnbound.plane === "delivery", { mgrUnbound, dlvUnbound });

  // =============================================================================================
  console.log("\nCELL GROUP B - BOUND: a responder binds, and the SAME probe now says so");
  // Same peer, same call, opposite condition. If the probe returned the same answer at every input
  // it could not pass both this group and group A.
  // =============================================================================================
  const supCreds = await mintCreds(auth, newIdentity(), "supervisor");
  const supEp = new CotalEndpoint({
    space, servers: SERVERS, creds: supCreds, card: { name: "sup", kind: "endpoint" },
    consume: false, registerPresence: false, watchPresence: false,
  });
  supEp.on("error", (e: Error) => console.error("  ! sup", e.message));
  await supEp.start();
  // The manager plane's responder, grading a flag the fixture controls — standing in for the real
  // manager's `serviceServe` handle, which is what the shipped manager grades.
  let managerServing = true;
  supEp.serveLiveness("manager", () => (managerServing ? "bound" : "unbound"));
  await new Promise((r) => setTimeout(r, 200));

  const mgrBound = await peer.probeLiveness("manager", 1_500);
  check("CELL B1: with a responder bound, the peer's MANAGER probe returns `bound`",
    mgrBound.responder === "bound", mgrBound);

  // The delivery plane, served by the SHIPPED `serveDeliveryLiveness` so the classifier under test
  // is the one that ships. Its lease is absent here, so the daemon grades ITSELF `unbound` — a
  // responder that answers while reporting that it is not ready, which is precisely the state the
  // reporter's daemon was in for 22 hours while every surface called it healthy.
  const dlvCreds = await mintCreds(auth, newIdentity(), "delivery");
  const dlvEp = new CotalEndpoint({
    space, servers: SERVERS, creds: dlvCreds, card: { name: "dlv", kind: "endpoint" },
    consume: false, registerPresence: false, watchPresence: false,
  });
  dlvEp.on("error", (e: Error) => console.error("  ! dlv", e.message));
  await dlvEp.start();
  dlvEp.serveDeliveryLiveness(0);
  await new Promise((r) => setTimeout(r, 200));

  const dlvAnswering = await peer.probeLiveness("delivery", 1_500);
  check("CELL B2: a daemon that ANSWERS but has not reached ready reports `unbound` about itself (it is not counted alive merely for replying)",
    dlvAnswering.responder === "unbound", dlvAnswering);

  // Now give the daemon a real ready lease through the SHIPPED acquire/mark path, and the same probe
  // flips to `bound`. This is the discriminator for the delivery plane: same responder, same peer,
  // same call, one fact changed.
  const rev = await dlvEp.acquireDeliveryLease(0);

  // BETWEEN THOSE TWO STATES LIES THE ONE THE REPORTER ACTUALLY WATCHED FOR 22 HOURS, and it needs
  // its own cell rather than being assumed to ride on B2. `acquireDeliveryLease` CAS-creates the row
  // `ready:false` BEFORE binding, so right now the slot is CLAIMED but the responder is not ready —
  // which is a different input to the classifier than B2's, where the row was ABSENT entirely and
  // the `lease === undefined` branch answered. A mutant that graded a not-ready row as `bound`
  // therefore survived B2 untouched: B2 never reached that branch. Measured, not predicted; this
  // cell exists because the mutation proof found the gap.
  const dlvClaimedNotReady = await peer.probeLiveness("delivery", 1_500);
  check("CELL B2b: a lease that is CLAIMED but not READY grades `unbound` (the 22-hour state: the slot is taken, the responder is not up)",
    dlvClaimedNotReady.responder === "unbound", dlvClaimedNotReady);

  await dlvEp.markDeliveryLeaseReady(0, rev);
  const dlvBound = await peer.probeLiveness("delivery", 1_500);
  check("CELL B3: once the lease is READY, the same DELIVERY probe returns `bound`",
    dlvBound.responder === "bound", dlvBound);

  // And back again: the responder is still bound and still answering, but the plane is no longer
  // serving. A surface that cached its answer at bind time would still say `bound` here.
  managerServing = false;
  const mgrNotServing = await peer.probeLiveness("manager", 1_500);
  check("CELL B4: a responder that is up but NOT serving answers `unbound` (state, not intent)",
    mgrNotServing.responder === "unbound", mgrNotServing);
  managerServing = true;

  // =============================================================================================
  console.log("\nCELL GROUP C - UNKNOWN IS FIRST CLASS: a plane that cannot grade itself is never health");
  // The axis this whole issue turns on. `unknown` must be reachable and must be distinct from both
  // health states, or the surface has reintroduced the original defect.
  // =============================================================================================
  // A responder whose readState THROWS: it cannot determine its own state. The shipped handler
  // answers `unknown` rather than falling silent or guessing.
  //
  // IT MUST HOLD THE `delivery` CREDENTIAL, not a supervisor one. The serve filter for a plane is
  // granted only to that plane's own credential (cells E2/E5), so a supervisor-cred responder here
  // would silently bind nothing and the probe would answer `unbound` — a red that looks exactly
  // like the surface folding unknown into unbound, while the real cause was the fixture holding the
  // wrong credential. That is what the first run of this suite did, and the distinction was settled
  // by reading the minted rows rather than by guessing at the red.
  const brokenCreds = await mintCreds(auth, newIdentity(), "delivery");
  const brokenEp = new CotalEndpoint({
    space, servers: SERVERS, creds: brokenCreds, card: { name: "broken", kind: "endpoint" },
    consume: false, registerPresence: false, watchPresence: false,
  });
  brokenEp.on("error", () => { /* the throw below is the subject of the cell */ });
  await brokenEp.start();
  // Stand this on the delivery plane, whose only current responder we first take down, so the
  // unreadable-lease responder is the one that answers.
  await dlvEp.stop().catch(() => { /* fine */ });
  await new Promise((r) => setTimeout(r, 200));
  brokenEp.serveLiveness("delivery", () => { throw new Error("lease unreadable"); });
  await new Promise((r) => setTimeout(r, 200));

  const dlvUnknown = await peer.probeLiveness("delivery", 1_500);
  check("CELL C1: a DELIVERY responder that cannot read its lease answers `unknown`, never `bound`",
    dlvUnknown.responder === "unknown", dlvUnknown);
  check("CELL C2: that `unknown` is distinct from the `unbound` the same probe returned when nothing was bound",
    dlvUnknown.responder !== dlvUnbound.responder, { unknown: dlvUnknown, unbound: dlvUnbound });

  // The same axis for the manager plane, so neither plane can be the one that quietly lacks it.
  managerServing = true;
  await supEp.stop().catch(() => { /* fine */ });
  await new Promise((r) => setTimeout(r, 200));
  const supBroken = await mintCreds(auth, newIdentity(), "supervisor");
  const mgrBrokenEp = new CotalEndpoint({
    space, servers: SERVERS, creds: supBroken, card: { name: "mgrbroken", kind: "endpoint" },
    consume: false, registerPresence: false, watchPresence: false,
  });
  mgrBrokenEp.on("error", () => { /* expected */ });
  await mgrBrokenEp.start();
  mgrBrokenEp.serveLiveness("manager", () => { throw new Error("cannot determine serve state"); });
  await new Promise((r) => setTimeout(r, 200));
  const mgrUnknown = await peer.probeLiveness("manager", 1_500);
  check("CELL C3: a MANAGER responder that cannot determine its state answers `unknown`, never `bound`",
    mgrUnknown.responder === "unknown", mgrUnknown);

  // The pure rule, exercised directly: only the broker's own no-responders report may become
  // `unbound`. A timeout, a refusal and an unreadable reply are all failures to FIND OUT.
  check("CELL C4: a probe TIMEOUT grades `unknown`, never `unbound` (a timeout is not the broker saying nothing is bound)",
    responderFromProbe("timeout") === "unknown", responderFromProbe("timeout"));
  check("CELL C5: a permission REFUSAL grades `unknown` - the peer learnt about its own credential, not about the plane",
    responderFromProbe("refused") === "unknown", responderFromProbe("refused"));
  check("CELL C6: an unreadable reply grades `unknown` - answering at all is not evidence of health (the `pgrep` error)",
    responderFromProbe("malformed") === "unknown", responderFromProbe("malformed"));
  check("CELL C7: only the broker's no-responders answer becomes `unbound`",
    responderFromProbe("noResponders") === "unbound", responderFromProbe("noResponders"));
  check("CELL C8: a reply carrying a verdict is NOT overridden - the responder grades itself",
    responderFromProbe("replied", "unbound") === "unbound" && responderFromProbe("replied", "bound") === "bound");
  check("CELL C9: a reply with NO readable verdict falls to `unknown`, not to `bound`",
    responderFromProbe("replied", undefined) === "unknown");

  // =============================================================================================
  console.log("\nCELL GROUP D - THE NON-OWNER BOUNDARY: presence is readable, everything else is refused");
  // The heart of the issue. A surface added to make liveness askable must not become a back door.
  // Each refusal below sits beside a CONTROL that is ALLOWED on the same credential in the same run:
  // a refusal on its own proves nothing, because a broken fixture is refused everything too.
  // =============================================================================================
  const peerRows = rowsFor("agent", peerId.id);
  const peerProbeSubject = livenessSubject(space, "manager", DEV_OWNER, peerId.id);

  // ALLOWED: the ask itself. This is the control that makes every refusal below meaningful.
  const canAsk = await tryPublish(peerCreds, peerId.id, peerProbeSubject);
  check("CELL D1 (CONTROL - the capability IS present): a non-owner peer MAY publish its own liveness probe",
    canAsk === "allowed", { subject: peerProbeSubject, verdict: canAsk });

  // REFUSED: asking AS SOMEONE ELSE. The identity slots are broker-enforced, so a peer cannot probe
  // under a peer's principal and cannot harvest another peer's answer.
  const forged = livenessSubject(space, "manager", DEV_OWNER, "someoneelse");
  const canForge = await tryPublish(peerCreds, peerId.id, forged);
  check("CELL D2: a peer CANNOT publish a probe under another principal's identity slots",
    canForge === "denied", { subject: forged, verdict: canForge });

  // REFUSED: impersonating the RESPONDER. If a peer could subscribe the serve filter it could answer
  // another peer's probe with a comforting lie — a surface built against false health that could be
  // used to manufacture it.
  const serveFilter = livenessServeFilter(space, "manager");
  const canServe = await trySubscribe(peerCreds, peerId.id, serveFilter);
  check("CELL D3: a peer CANNOT subscribe the responder's SERVE filter (it cannot answer for a plane)",
    canServe === "denied", { subject: serveFilter, verdict: canServe });
  // The control for D3: the same peer, the same connection, a subscribe that IS allowed. Without
  // this, a fixture that could not subscribe anything would pass D3 while proving nothing.
  const ownReply = `${peerProbeSubject}.reply.control`;
  const canHearOwn = await trySubscribe(peerCreds, peerId.id, ownReply);
  check("CELL D4 (CONTROL for D3): the same peer on the same credential CAN subscribe its OWN reply lane",
    canHearOwn === "allowed", { subject: ownReply, verdict: canHearOwn });

  // REFUSED: naming SOMEONE ELSE'S lane as the reply target. The broker does not permission-check a
  // requester's embedded reply subject, so without the responder's own bound-reply guard an
  // authenticated peer could point a probe's reply at a VICTIM's lane and make the responder publish
  // into it — the confused-deputy shape `serveControl` documents, reproduced on a new rail.
  //
  // THE OBSERVER MUST BE THE VICTIM, and the first version of this cell got that wrong in a way
  // worth recording. It had the ATTACKER wait for its own request to time out — but the attacker
  // cannot subscribe a lane it does not own, so it heard nothing whether the guard was present or
  // absent, and the mutant that deleted the guard survived a cell written to catch it. A detector
  // that returns the same answer under both conditions is not measuring anything. So a real second
  // agent listens on ITS OWN reply subtree (which its own grant permits) and the question becomes
  // the one that matters: does anything arrive there that the victim never asked for?
  const victimId = newIdentity();
  const victimUid = mintLifecycleUid();
  const victimCreds = await provisionAgent(mgr, auth, victimId, {
    subscribe: ["general"], allowSubscribe: ["general"], lifecycleUid: victimUid,
  });
  const victimSubject = livenessSubject(space, "manager", DEV_OWNER, victimId.id);
  const victimNc = await connect({
    servers: SERVERS,
    authenticator: credsAuthenticator(new TextEncoder().encode(victimCreds)),
    inboxPrefix: `_INBOX_${victimId.id}`,
    maxReconnectAttempts: 0,
  });
  let victimHeard = 0;
  const victimSub = victimNc.subscribe(`${victimSubject}.>`, { callback: (err) => { if (!err) victimHeard++; } });
  await victimNc.flush();

  // The attacker aims its probe's reply at the victim's lane. Its own request will not return
  // either way (it cannot subscribe that lane), which is precisely why the verdict is read from the
  // VICTIM's counter rather than from the attacker's outcome.
  const victimLane = `${victimSubject}.reply.stolen`;
  const deputyNc = await connect({
    servers: SERVERS,
    authenticator: credsAuthenticator(new TextEncoder().encode(peerCreds)),
    inboxPrefix: `_INBOX_${peerId.id}`,
    maxReconnectAttempts: 0,
  });
  try {
    await deputyNc.request(peerProbeSubject, new Uint8Array(0), { timeout: 1_000, noMux: true, reply: victimLane });
  } catch {
    /* the attacker hearing nothing is expected and is NOT the measurement */
  }
  await new Promise((r) => setTimeout(r, 400));
  const heardAfterAttack = victimHeard;
  check("CELL D4b: a probe whose reply target is ANOTHER peer's lane delivers NOTHING into that peer's lane (no confused deputy)",
    heardAfterAttack === 0, { victimLane, framesDeliveredToVictim: heardAfterAttack });

  // THE CONTROL, and it is what makes the zero above mean something rather than merely proving the
  // victim's subscription never worked: the victim probes on its OWN behalf, and a frame DOES land
  // in the same lane, over the same subscription, in the same run.
  try {
    await victimNc.request(victimSubject, new Uint8Array(0), { timeout: 1_000, noMux: true, reply: `${victimSubject}.reply.${randomUUID()}` });
  } catch {
    /* graded by the counter below */
  }
  await new Promise((r) => setTimeout(r, 400));
  check("CELL D4c (CONTROL for D4b): the victim's OWN probe DOES deliver into that same lane (the zero above is a refusal, not a dead subscription)",
    victimHeard > heardAfterAttack, { before: heardAfterAttack, after: victimHeard });
  try { victimSub.unsubscribe(); } catch { /* ignore */ }
  await victimNc.drain().catch(() => { /* fine */ });
  await deputyNc.drain().catch(() => { /* fine */ });

  // REFUSED, and this is the boundary the issue asks to be pinned: the peer gains NO read of the
  // state behind the answer. The manager lease row carries the operator's workspace root and pid;
  // making liveness askable must not hand those over.
  check("CELL D5: the peer holds NO read grant on the manager lease bucket (no holder, no pid, no workspace root)",
    !grants(peerRows.pub, `$JS.API.STREAM.MSG.GET.KV_${managerBucket(space)}`) &&
      !grants(peerRows.pub, `$JS.API.STREAM.INFO.KV_${managerBucket(space)}`) &&
      !grants(peerRows.pub, `$JS.API.DIRECT.GET.KV_${managerBucket(space)}.${MANAGER_LEASE_KEY}.x`),
    { offenders: peerRows.pub.filter((r) => r.includes(managerBucket(space))) });
  check("CELL D6: the peer holds NO WRITE on the manager lease bucket either (it cannot evict a supervisor)",
    !grants(peerRows.pub, `$KV.${managerBucket(space)}.${MANAGER_LEASE_KEY}.someinstance`),
    { offenders: peerRows.pub.filter((r) => r.includes(managerBucket(space))) });
  check("CELL D7: the peer holds NO WRITE on the delivery lease (one writer: the `delivery` cred)",
    !grants(peerRows.pub, `$KV.${deliveryBucket(space)}.lease.0`),
    { offenders: peerRows.pub.filter((r) => subjectMatches(r, `$KV.${deliveryBucket(space)}.lease.0`)) });

  // The wire answer itself carries nothing beyond presence. Checked on a REAL reply rather than on
  // the type, because the type cannot stop a handler from attaching an extra field.
  const rawNc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds: peerCreds, tls: false }), maxReconnectAttempts: 0 });
  let wireKeys: string[] = [];
  try {
    const subj = livenessSubject(space, "manager", DEV_OWNER, peerId.id);
    const m = await rawNc.request(subj, "", { timeout: 1_500, noMux: true, reply: `${subj}.reply.${randomUUID()}` });
    wireKeys = Object.keys(m.json() as Record<string, unknown>).sort();
  } catch (e) {
    wireKeys = [`(probe failed: ${(e as Error).message})`];
  } finally {
    await rawNc.drain().catch(() => { /* fine */ });
  }
  check("CELL D8: the wire answer carries EXACTLY {plane, responder} - no holder, pid, root, instance id or roster",
    wireKeys.length === 2 && wireKeys[0] === "plane" && wireKeys[1] === "responder", { wireKeys });

  // REFUSED: a plane outside the closed set. A probe that answered for every input would be the
  // "same answer at every input" instrument, and would report health for planes that do not exist.
  let refusedUnknownPlane = false;
  try { await peer.probeLiveness("broker", 500); }
  catch { refusedUnknownPlane = true; }
  check("CELL D9: a peer asking about a plane outside the closed set is REFUSED, not answered",
    refusedUnknownPlane);
  check("CELL D10 (CONTROL for D9): the closed set is not empty and the named planes ARE accepted",
    LIVENESS_PLANES.length === 2 && LIVENESS_PLANES.includes("manager") && LIVENESS_PLANES.includes("delivery"),
    [...LIVENESS_PLANES]);

  // A reply whose plane does not match the one asked about is not readable as an answer: a peer
  // cannot be handed a `bound` for delivery in response to a question about the manager.
  check("CELL D11: a reply naming a DIFFERENT plane than the one asked about is rejected, not adopted",
    parseLivenessAnswer({ plane: "delivery", responder: "bound" }, "manager") === undefined);
  check("CELL D12: a reply with an unrecognised responder value is rejected (it grades `unknown`, never `bound`)",
    parseLivenessAnswer({ plane: "manager", responder: "healthy" }, "manager") === undefined);

  // =============================================================================================
  console.log("\nCELL GROUP E - THE RESPONDERS HOLD WHAT THEY NEED, AND NOTHING MORE");
  // The mirror of group D: proving nobody can serve is worthless if the real responders lost the
  // authority to answer, because then the fix would have broken the surface it added.
  // =============================================================================================
  const supRows = rowsFor("supervisor", "sup");
  check("CELL E1: the `supervisor` CAN subscribe the manager plane's serve filter (it can answer)",
    grants(supRows.sub, livenessServeFilter(space, "manager").replace("*.*", "a.b")),
    { rows: supRows.sub });
  check("CELL E2: the `supervisor` CANNOT serve the DELIVERY plane (each plane answers for itself)",
    !grants(supRows.sub, livenessServeFilter(space, "delivery").replace("*.*", "a.b")),
    { offenders: supRows.sub.filter((r) => r.includes(".live.delivery.")) });
  check("CELL E3: the supervisor's reply grant is bounded to the `.reply.` leaf - it cannot publish a probe AS a peer",
    grants(supRows.pub, `${livenessSubject(space, "manager", DEV_OWNER, "somepeer")}.reply.x`) &&
      !grants(supRows.pub, livenessSubject(space, "manager", DEV_OWNER, "somepeer")),
    { rows: supRows.pub.filter((r) => r.includes(".live.")) });

  const dlvRows = rowsFor("delivery", "dlv");
  check("CELL E4: the `delivery` cred CAN subscribe the delivery plane's serve filter",
    grants(dlvRows.sub, livenessServeFilter(space, "delivery").replace("*.*", "a.b")),
    { rows: dlvRows.sub });
  check("CELL E5: the `delivery` cred CANNOT serve the MANAGER plane",
    !grants(dlvRows.sub, livenessServeFilter(space, "manager").replace("*.*", "a.b")),
    { offenders: dlvRows.sub.filter((r) => r.includes(".live.manager.")) });

  await peer.stop().catch(() => { /* fine */ });
  await mgrBrokenEp.stop().catch(() => { /* fine */ });
  await brokenEp.stop().catch(() => { /* fine */ });
  await mgr.stop().catch(() => { /* fine */ });
} catch (e) {
  fail++;
  console.log(`  ✗ FAIL: the suite threw - ${(e as Error).message}`);
  console.error(e);
}

console.log(fail === 0
  ? `\nPEER LIVENESS SMOKE OK ✅  (${pass} passed, ${fail} failed)`
  : `\nPEER LIVENESS SMOKE FAILED ❌  (${pass} passed, ${fail} failed)`);
emitSentinel({ passed: pass, failed: fail });
process.exit(fail === 0 ? 0 : 1);
