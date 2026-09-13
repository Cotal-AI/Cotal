/**
 * delivery single-flight lease smoke. Two clients binding the same `fanout`/`reader` durable name SPLIT
 * delivery, so the daemon CAS-acquires a per-shard lease BEFORE binding and refuses (loud exit) if a live
 * lease exists. Asserts: a second acquire on the same shard THROWS; the lease flips ready only after a
 * mark; a ready lease held by ANOTHER daemon does not satisfy a wait for the daemon we launched
 * (#837); release frees it so a fresh acquire succeeds.
 *
 * Run: pnpm smoke:delivery-lease:auth   (needs `nats-server` on PATH; auth/JetStream, local-only)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CotalEndpoint, isReachable, createSpaceAuth, mintCreds, provisionAgent, mintLifecycleUid, serverConfig, newIdentity, setupSpaceStreams, waitForDeliveryLease, chatStream, standaloneConnectOpts, fanoutDurableConfig, FANOUT_DURABLE, idFromCreds, deliveryLeaseHolderFor, controlServiceSubject, CONTROL_DELIVERY, DEV_OWNER } from "../src/index.js";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import { jetstreamManager, AckPolicy } from "@nats-io/jetstream";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const awaitExit = (proc: ReturnType<typeof spawn>, t = 3000): Promise<void> =>
  new Promise((resolve) => { if (proc.exitCode !== null || proc.signalCode !== null) return resolve(); proc.once("exit", () => resolve()); setTimeout(resolve, t); });
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

const space = `delivery-lease-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);

const mkDaemon = async () =>
  new CotalEndpoint({
    space, servers: SERVERS, creds: await mintCreds(auth, newIdentity(), "delivery"), channels: [],
    consume: false, watchPresence: false, registerPresence: false,
    card: { name: "delivery", role: "delivery", kind: "endpoint" },
  });

let d1: CotalEndpoint | undefined, d2: CotalEndpoint | undefined;
try {
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);
  await setupSpaceStreams({ servers: SERVERS, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });

  d1 = await mkDaemon(); d1.on("error", () => {}); await d1.start();
  d2 = await mkDaemon(); d2.on("error", () => {}); await d2.start();

  const rev1 = await d1.acquireDeliveryLease(0);
  check("first daemon acquires the shard-0 lease", typeof rev1 === "number");

  let secondThrew = false;
  try { await d2.acquireDeliveryLease(0); } catch { secondThrew = true; }
  check("a second daemon on the same shard is REFUSED (CAS create fails)", secondThrew);

  const before = await d1.readDeliveryLease(0);
  check("lease is NOT ready until the daemon marks it (responder bound)", before?.ready === false);
  const readyRev = await d1.markDeliveryLeaseReady(0, rev1);
  const after = await d1.readDeliveryLease(0);
  check("lease reads ready + held by the first daemon after markReady", after?.ready === true && after?.holder === d1.card.id);

  // #837: WHOSE readiness. `waitForDeliveryLease` used to accept ANY ready lease, so a launcher
  // waiting on the daemon it had just started was answered by a DIFFERENT daemon's record — and a
  // SIGKILLed holder leaves exactly such a record behind for the rest of the bucket TTL. The
  // replacement that lost the CAS and exited was then reported ready, and `up` printed green with no
  // daemon running at all. The lease here is ready and held by d1; d2 is the daemon nobody started.
  const probeId = newIdentity();
  const probeCreds = await mintCreds(auth, probeId, "delivery");
  const waitFor = (holder: string | undefined) =>
    waitForDeliveryLease({ servers: SERVERS, space, creds: probeCreds, id: probeId.id, holder, timeoutMs: 1500 });
  check("CONTROL: waiting for the lease's ACTUAL holder sees it ready", await waitFor(d1.card.id));
  check("a ready lease held by another daemon does NOT answer for the one we launched", (await waitFor(d2.card.id)) === false);
  check("CONTROL: an unnamed holder (adopting a running daemon) still accepts any ready lease", await waitFor(undefined));

  // #837 AGAIN, FROM THE LAUNCHER'S SIDE. The three cells above hand the wait `d1.card.id`, taken off
  // a live endpoint object - so they grade the WAIT while assuming the hardest part, which is that a
  // launcher can work out that string in the first place. It cannot read it off anything: it holds a
  // creds FILE, and the process that will write the row does not exist yet. Deriving the bare nkey
  // from that cred is the obvious move and is wrong, because the endpoint rewrites `card.id` to the
  // principal dot-form before stamping it, so the comparison could only ever be false - the #837
  // guarantee defeated by a test that never fires rather than by one that accepts anything. That is
  // what `cotal up` actually did on every fresh launch until this was found in review (#1318).
  const launchCreds = await mintCreds(auth, newIdentity(), "delivery");
  const launched = new CotalEndpoint({
    space, servers: SERVERS, creds: launchCreds, channels: [],
    consume: false, watchPresence: false, registerPresence: false,
    card: { id: idFromCreds(launchCreds), name: "delivery", role: "delivery", kind: "endpoint" },
  });
  launched.on("error", () => {}); await launched.start();
  try {
    const lrev = await launched.acquireDeliveryLease(1);
    await launched.markDeliveryLeaseReady(1, lrev);
    const row = await launched.readDeliveryLease(1);
    // The launcher has ONLY the cred. This is the whole cell: does the value it can derive match the
    // value the daemon wrote?
    check("the holder a launcher derives from the cred alone MATCHES the row the daemon wrote",
      deliveryLeaseHolderFor(launchCreds) === row?.holder,
      { derived: deliveryLeaseHolderFor(launchCreds), written: row?.holder });
    // REFUSING CONTROL: the derivation is not just returning whatever is in the row. A different
    // cred must derive a holder that does NOT match.
    check("CONTROL: a DIFFERENT cred derives a holder that does not match that row",
      deliveryLeaseHolderFor(await mintCreds(auth, newIdentity(), "delivery")) !== row?.holder);
    await launched.releaseDeliveryLease(1, (await launched.readDeliveryLeaseEntry(1))?.revision);
  } finally { await launched.stop(); }

  // A STALE REVISION RELEASES NOTHING, AND SAYS SO TO NOBODY. The release is a compare-and-swap,
  // and `releaseDeliveryLease` swallows every error by design (at shutdown the broker may already be
  // gone), so a token one step behind frees nothing and reports success. The row then claims the
  // shard for the rest of the bucket TTL with no process behind it, and the next daemon is refused
  // outright: "a live lease already exists". That is #1318's outage with no starvation and no broker
  // fault anywhere, reached by an ordinary stop and restart.
  //
  // The token lags on ordinary interleavings, not only on faults. `markDeliveryLeaseReady` MOVES the
  // row, so between the broker applying that write and the daemon assigning the returned value the
  // cached revision is still the acquire token; a markReady that rejects after its write landed
  // leaves the same lag permanently, since the daemon catches it (correctly - the renew loop
  // repairs it). Either way the launcher can already have seen the row ready. So this grades the
  // endpoint surface the daemon's shutdown depends on, rather than the daemon's own timing.
  const st = await mkDaemon(); st.on("error", () => {}); await st.start();
  try {
    const stAcquired = await st.acquireDeliveryLease(2);
    const stReady = await st.markDeliveryLeaseReady(2, stAcquired);
    check("markReady MOVES the revision, so a token cached before it is stale", stReady !== stAcquired,
      { acquired: stAcquired, afterReady: stReady });
    // THE DEFECT: release with the pre-markReady token, exactly what the swallowed catch leaves.
    await st.releaseDeliveryLease(2, stAcquired);
    check("a release arguing a STALE revision leaves the row in place — silently",
      (await st.readDeliveryLease(2)) !== undefined);
    // ACCEPT CONTROL: the same call with the broker's current revision does free it, so the failure
    // above is the token rather than the release being broken for every input.
    await st.releaseDeliveryLease(2, (await st.readDeliveryLeaseEntry(2))?.revision);
    check("CONTROL: releasing at the BROKER's current revision removes the row",
      (await st.readDeliveryLease(2)) === undefined);
    // THE CONSEQUENCE an operator feels: a replacement can claim the shard again.
    const stNext = await mkDaemon(); stNext.on("error", () => {}); await stNext.start();
    try {
      let claimed = -1;
      try { claimed = await stNext.acquireDeliveryLease(2); } catch { /* refused */ }
      check("and a replacement daemon can then ACQUIRE the shard", claimed > 0, { claimed });
      await stNext.releaseDeliveryLease(2, claimed > 0 ? claimed : undefined);
    } finally { await stNext.stop(); }
  } finally { await st.stop(); }

  // RELEASE ARGUES THE REVISION IT LAST OWNED, and `markDeliveryLeaseReady` moved it — a release
  // offering the stale `rev1` is refused, which is the correct outcome for a row that has moved on
  // and the wrong one here, where this daemon genuinely still holds the shard.
  await d1.releaseDeliveryLease(0, readyRev);
  let reacquired = false;
  try { await d2.acquireDeliveryLease(0); reacquired = true; } catch { /* still held */ }
  check("after release, a fresh daemon CAN acquire the freed lease", reacquired);

  // ---- Q: A REARM THAT FAILS PART-WAY MUST LEAVE THE ENDPOINT QUIESCED (found in review) ----
  // `armPlane3` binds in four stages, so it can fail with some of them up. The first version of
  // `rearmPlane3` cleared `plane3Quiesced` BEFORE calling it, which looks equivalent and is not: on a
  // throw the endpoint recorded itself un-quiesced while unbound, every later `rearmPlane3` returned at
  // the `!plane3Quiesced` guard WITHOUT retrying, and `resumeServing` went on to flip the lease READY.
  // A transient broker error therefore became a permanent readiness lie: the daemon advertises a
  // responder it does not have. That is #1318's outage hiding in the readiness flag instead of the exit
  // path, so the recovery this branch added would have re-introduced the class it exists to remove.
  //
  // The failure is injected at the BROKER, not with a stub: the fan-out durable is replaced by one with
  // an incompatible config, so the real `runFanout` gets a real `consumer already exists` from a real
  // nats-server. Nothing here is mocked, and the arm path under test is the shipped one.
  const d3 = await mkDaemon(); d3.on("error", () => {}); await d3.start();
  await d3.startPlane3(() => undefined);
  check("Q1 CONTROL: a healthy Plane-3 endpoint reports itself serving (not quiesced)", d3.plane3IsQuiesced() === false);

  await d3.quiescePlane3();
  check("Q2 CONTROL: quiescing records the endpoint as not serving", d3.plane3IsQuiesced() === true);

  // Make the next fan-out bind fail, at the broker.
  // The `delivery` role is the one the broker grants consumer-create on the chat stream, which is the
  // same grant the daemon itself arms with. A provisioner cred is refused here, correctly.
  const conflictNc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds: await mintCreds(auth, newIdentity(), "delivery"), tls: false }) });
  const jsmConflict = await jetstreamManager(conflictNc);
  const chat = chatStream(space);
  await jsmConflict.consumers.delete(chat, FANOUT_DURABLE).catch(() => {});
  // An ack policy the daemon's own config contradicts, so `runFanout` gets a real
  // `consumer already exists` from a real broker rather than a stubbed rejection.
  await jsmConflict.consumers.add(chat, { ...fanoutDurableConfig(space), ack_policy: AckPolicy.None, durable_name: FANOUT_DURABLE });

  let rearmThrew = false;
  try { await d3.rearmPlane3(); } catch { rearmThrew = true; }
  check("Q3 a rearm whose binding fails at the broker THROWS rather than reporting success", rearmThrew);
  // THE DEFECT. Pre-fix this read false: the flag was cleared before the throw.
  check("Q4 and the endpoint is STILL QUIESCED after that failure, not silently un-quiesced", d3.plane3IsQuiesced() === true);

  // The consequence that made it a merge blocker: a later retry must actually retry. Pre-fix the
  // second call returned `ok` at the `!plane3Quiesced` guard WITHOUT binding anything, so the caller
  // marked the lease ready over an endpoint with no fan-out at all.
  let secondRearmThrew = false;
  try { await d3.rearmPlane3(); } catch { secondRearmThrew = true; }
  check("Q5 a LATER retry still attempts the bind (it fails again while the conflict stands)", secondRearmThrew);
  check("Q6 and it is still quiesced, so readiness is never claimed over missing bindings", d3.plane3IsQuiesced() === true);

  // Clear the conflict: the same retry path must now genuinely recover, or the fix has merely
  // converted a readiness lie into a daemon that can never come back.
  await jsmConflict.consumers.delete(chat, FANOUT_DURABLE).catch(() => {});
  await d3.rearmPlane3();
  check("Q7 REFUSING CASE: once the broker recovers, the SAME retry path resumes serving", d3.plane3IsQuiesced() === false);
  const fanoutBack = await jsmConflict.consumers.info(chat, FANOUT_DURABLE).then(() => true, () => false);
  check("Q8 and the fan-out durable is really bound again, read from the broker", fanoutBack);

  // ── V. A UNIT ALREADY IN FLIGHT MUST NOT TAKE EFFECT AFTER THE QUIESCE ─────────────────
  //
  // A REVIEWER FINDING, and it is the half of "one server" that unsubscribing cannot deliver.
  // `quiescePlane3` stops NEW work: it unsubscribes the responders and stops the consumers. It
  // cannot recall work already dispatched. A handler that entered before the freeze and awaited
  // broker I/O inside it RESUMES after it, and the ordering that makes that a split rather than a
  // blip is: the loser accepts a request and awaits, the loser is descheduled, the successor
  // acquires the shard and flips its lease READY, the loser resumes and answers for a shard it no
  // longer holds. Two live servers on one shard, which is what the lease exists to prevent.
  //
  // THE STARVATION SUITE'S CELL G COULD NOT SEE THIS, and that is the point of adding it here: G
  // reads subscription counts and parked pulls, and INJECTS NO TRAFFIC, so a daemon with no work in
  // flight looks identical to one whose in-flight work is about to land. The effect is the REPLY,
  // not the binding. So this drives the real `ctl.delivery` rail over the wire and grades what the
  // caller actually receives.
  console.log("\nV. work dispatched before a quiesce must not act after it");
  // SOLE SERVER ON THE RAIL, or this cell grades nothing. `serveControl` subscribes with a QUEUE
  // group, so every endpoint this suite has started is a candidate responder for the same subject.
  // The first version of this cell left them up, and V3 went green-then-red on `ok:true` served by a
  // DIFFERENT daemon - which is correct queue behaviour and says nothing about the one under test.
  // The others are stopped first so the only endpoint that can answer is the one being quiesced.
  for (const other of [d1, d2, d3]) { try { await other?.stop(); } catch { /* ignore */ } }
  d1 = undefined; d2 = undefined;

  // A FRESH daemon with a REAL ACL resolver: d3 above is mid-experiment (quiesced and rearmed by the
  // Q cells) and was started with a stub resolver that answers no ACL at all, so it cannot serve a
  // control request and could never provide the accept control this cell needs.
  const dv = await mkDaemon(); dv.on("error", () => {}); await dv.start();
  await dv.startPlane3((owner, lifecycleUid) => dv.aclForOwner(owner, lifecycleUid));
  const vIdentity = newIdentity();
  const vLifecycleUid = mintLifecycleUid();
  const vNoop = { commitAcl: async () => {}, reissueAcl: async () => {}, provisionDmInbox: async () => {}, provisionDlvInbox: async () => {}, provisionTaskQueue: async () => {} };
  const vCreds = await provisionAgent(vNoop, auth, vIdentity, { subscribe: [], allowSubscribe: [], lifecycleUid: vLifecycleUid });
  const vNc = await connect({
    servers: SERVERS, authenticator: credsAuthenticator(new TextEncoder().encode(vCreds)),
    inboxPrefix: `_INBOX_${vIdentity.id}`, maxReconnectAttempts: 0,
  });
  try {
    const vSubject = controlServiceSubject(space, CONTROL_DELIVERY, DEV_OWNER, vIdentity.id);
    // BOUND REPLY, because the rail demands it: `serveControl(..., { boundReply: true })` answers only
    // when `m.reply` sits under the authenticated request subject, which is the confused-deputy
    // defence. A plain `nc.request()` uses an `_INBOX_` reply and is silently never answered - it
    // cost this cell two red accept controls before the harness was fixed, which is the harness
    // being broken rather than the daemon.
    const ask = async (): Promise<{ ok?: boolean; error?: string } | undefined> => {
      const replyTo = `${vSubject}.reply.${randomUUID()}`;
      const inbox = vNc.subscribe(replyTo, { max: 1 });
      // An EMPTY body is a real outcome here, not a parse bug: once the rail is unsubscribed nobody
      // answers, and the race below resolves undefined. Decode defensively so "no answer" reports as
      // no answer rather than throwing out of the suite.
      const answer = (async () => {
        for await (const m of inbox) {
          try { return m.json<{ ok?: boolean; error?: string }>(); } catch { return { error: "unparseable reply" }; }
        }
        return undefined;
      })();
      vNc.publish(vSubject, new TextEncoder().encode(JSON.stringify({
        op: "listMemberships", args: { lifecycleUid: vLifecycleUid },
        from: { id: `${DEV_OWNER}.${vIdentity.id}`, name: "v-caller", kind: "agent" }, // the subject encodes owner.actor; `from.id` must be that dot-form, not the bare nkey
      })), { reply: replyTo });
      await vNc.flush();
      const out = await Promise.race([answer, wait(2500).then(() => undefined)]);
      try { inbox.unsubscribe(); } catch { /* already gone */ }
      return out;
    };
    // ACCEPT CONTROL FIRST, so a refusal below is the fence rather than a rail that never worked.
    const vServing = await ask();
    check("V1 CONTROL: while serving, the control rail ANSWERS this caller", vServing?.ok === true, vServing);
    // Now the daemon stops serving the shard, exactly as a failed renew makes it.
    await dv.quiescePlane3();
    check("V2 the endpoint records itself as not serving", dv.plane3IsQuiesced() === true);
    const vQuiesced = await ask();
    // The subscription is gone, so the honest outcomes are "no reply" or "a refusal". What must
    // NEVER happen is an ok:true answer served for a shard this daemon has stopped serving.
    check("V3 a request is NOT answered ok by a daemon that has stopped serving the shard",
      vQuiesced?.ok !== true, vQuiesced);
    // REFUSING CASE, and it is what keeps V3 from passing on a permanently dead rail: the same call
    // is answered again once ownership is re-proven and serving resumes.
    await dv.rearmPlane3();
    const vBack = await ask();
    check("V4 REFUSING CASE: once serving resumes, the SAME request is answered again", vBack?.ok === true, vBack);

    // V5-V6 ARE THE CELLS THAT ACTUALLY GRADE THE FENCE, and V3 above is NOT one of them: with the
    // rail unsubscribed nobody answers at all, so V3 stays green with every fence removed. Measured,
    // not assumed - that control is why these two exist.
    //
    // The ordering under test is the one three reviewers described: a request ADMITTED while serving,
    // descheduled inside its broker read, resuming after a successor has taken the shard. It is
    // reproduced by quiescing WHILE the request is in flight rather than before it, so the handler
    // entered through a live subscription and returns through a stood-down daemon.
    const inflight = ask();
    await wait(1);                 // let the request reach the handler and enter its await
    await dv.quiescePlane3();      // the successor has taken the shard; this daemon stands down
    const vInflight = await inflight;
    check("V5 a request admitted BEFORE the quiesce is not answered ok after it", vInflight?.ok !== true, vInflight);
    check("V6 and it is refused by name rather than silently dropped, so the caller can retry",
      vInflight === undefined || /stopped serving this shard/.test(vInflight.error ?? ""), vInflight);
  } finally {
    try { await vNc.close(); } catch { /* ignore */ }
    try { await dv.stop(); } catch { /* ignore */ }
  }

  // d3 was stopped above, before the V cells took sole ownership of the control rail.
  // Drain the observer connection, or the suite's event loop stays alive on an open socket and the
  // run hangs after the last cell instead of exiting.
  try { await conflictNc.close(); } catch { /* ignore */ }

  console.log(`\nDELIVERY-LEASE SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).message);
  process.exitCode = 1;
} finally {
  try { await d1?.stop(); } catch { /* ignore */ }
  try { await d2?.stop(); } catch { /* ignore */ }
  srv.kill("SIGKILL");
  await awaitExit(srv);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker(); // last: ownership is held until this teardown has actually finished
}
