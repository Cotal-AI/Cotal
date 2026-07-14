/**
 * v0.4 §13.6 SESSION (bidirectional stream) smoke — the composite's three layers:
 *
 *   A. the SESSION GRANT artifact (broker-free): mint → verify round-trip; the refusal
 *      battery — wrong audience, substituted/tampered rail subjects, unknown field, unknown/
 *      revoked/wrong-role/scope-closed key, tampered payload, expired, not-yet-valid, TTL over
 *      the live ceiling, window out of bounds.
 *   B. the LEDGER + REDEMPTION seam (faithful in-memory ledger): one-use (duplicate redemption
 *      loses the create-CAS and revokes only ITS OWN staged pair), finalize fresh-checks
 *      (holder-epoch drift → retired, serving-epoch drift → superseded, dead lifecycle →
 *      retired; each revokes both staged ids and releases nothing), redemption-racing-close
 *      loses its finalize, crash-mid-issue leaves an `issuing` row the sweep collects (both
 *      ids revoked, tombstoned), state-grammar monotonicity, pre-check refusals burn nothing.
 *   C. the RAILS over a REAL broker: duplex in-order delivery with credits cycling through a
 *      small window; window overflow REFUSES resource-exhausted (no buffering); a sequence
 *      GAP breaks the session loudly (credits stall); duplicates drop; garbled frames and
 *      credit overruns surface as protocol errors; the in-band close is advisory
 *      (peer notified, local rail refuses further sends).
 *   D. NO STANDING EPS GRANT: the caller/serve grant builders emit no `eps.` row (§13.9
 *      :2068-2070 — both sides hold only redemption-minted per-session credentials).
 *
 * Run: pnpm smoke:ep-session   (needs nats-server on PATH; part of smoke:ci)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { createUser } from "@nats-io/nkeys";
import {
  isReachable, EpEnvelopeError, signArtifact,
  mintSessionGrant, verifySessionGrant, mintSessionId, redeemSession, retrieveServingCredential, sweepSessionRow,
  sessionLedgerKey, assertSessionStateTransition, openSessionRail, encodeSessionFrame, parseSessionFrame,
  epsSubject, epCallerGrantRows, epServeGrantRows,
  SESSION_GRANT_MAX_TTL_MS, SESSION_WINDOW_MAX,
  type SessionGrant, type SessionLedger, type SessionLedgerRow, type SessionRedemptionHooks,
  type SignerAnchor, type AnchorResolver,
} from "../src/index.js";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); } };
const rejects = async (n: string, fn: () => Promise<unknown> | unknown, code?: string) => {
  try { await fn(); c(n, false, "no throw"); } catch (e) {
    c(n, code === undefined || (e instanceof EpEnvelopeError && e.code === code), `code ${(e as EpEnvelopeError).code ?? (e as Error).message}`);
  }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean, ms = 4000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (f()) return true; await wait(20); }
  return f();
}

const SPACE = "epsession";
const ENDPOINT = "term";
const NOW = 1_700_000_000_000;
const kp = createUser();
const HOLDER = { id: "u_holder.cli", lifecycleUid: "h".repeat(26), processEpoch: 3 };
const SERVING = { instanceId: "s".repeat(26), epoch: 7 };
const anchors = new Map<string, SignerAnchor>();
anchors.set("k1", {
  keyId: "k1", publicKey: kp.getPublicKey(), owner: ENDPOINT,
  roles: ["sessions"], scope: { sessions: [ENDPOINT] }, validFrom: NOW - 1000, validTo: NOW + SESSION_GRANT_MAX_TTL_MS * 2,
});
const resolveAnchor: AnchorResolver = (id) => anchors.get(id);
const mint = (over: Record<string, unknown> = {}) =>
  mintSessionGrant({ space: SPACE, endpoint: ENDPOINT, holder: HOLDER, serving: SERVING, ttlMs: 60_000, issuerKeyId: "k1", now: NOW, ...(over as object) }, kp);
const verify = (g: unknown, now = NOW + 10) => verifySessionGrant(g, { space: SPACE, resolveAnchor, now });

// ---------- A. the grant artifact ----------
console.log("A. session grant mint → verify + refusal battery");
{
  const g = mint();
  const v = await verify(g);
  c("grant round-trips mint → verify (subjects derived + carried agree)", v.sessionId === g.sessionId && v.subjects.in.endsWith(".in") && v.window === 64);
  c("sessionId is fresh + unguessable-sized", g.sessionId.length >= 22 && mintSessionId() !== mintSessionId());
}
await rejects("wrong space (audience) refuses", () => verifySessionGrant(mint(), { space: "other", resolveAnchor, now: NOW }), "permission-denied");
await rejects("tampered rail subject kills the signature", async () => {
  const g = mint();
  const forged = { ...g, subjects: { ...g.subjects, in: g.subjects.in.replace(".in", ".out") } };
  await verify(forged);
}, "permission-denied");
await rejects("re-signed substituted subjects fail the derivation check", async () => {
  const g = mint();
  const { sig: _s, ...unsigned } = g;
  const swapped = signArtifact({ ...unsigned, subjects: { in: epsSubject(SPACE, ENDPOINT, g.sessionId, 99, "in"), out: epsSubject(SPACE, ENDPOINT, g.sessionId, 99, "out") } }, kp);
  await verify(swapped);
}, "permission-denied");
await rejects("unknown field refuses (closed schema)", async () => verify({ ...mint(), extra: 1 }), "contract-invalid");
await rejects("tampered window (payload) kills the signature", async () => verify({ ...mint(), window: 9 }), "permission-denied");
await rejects("unknown signing key refuses", async () => {
  const g = mintSessionGrant({ space: SPACE, endpoint: ENDPOINT, holder: HOLDER, serving: SERVING, ttlMs: 60_000, issuerKeyId: "nope", now: NOW }, kp);
  await verify(g);
}, "permission-denied");
await rejects("revoked key refuses", async () => {
  anchors.set("krev", { ...anchors.get("k1")!, keyId: "krev", revoked: true });
  await verify(mintSessionGrant({ space: SPACE, endpoint: ENDPOINT, holder: HOLDER, serving: SERVING, ttlMs: 60_000, issuerKeyId: "krev", now: NOW }, kp));
}, "permission-denied");
await rejects("key without the sessions role refuses", async () => {
  anchors.set("krole", { ...anchors.get("k1")!, keyId: "krole", roles: ["handles"] });
  await verify(mintSessionGrant({ space: SPACE, endpoint: ENDPOINT, holder: HOLDER, serving: SERVING, ttlMs: 60_000, issuerKeyId: "krole", now: NOW }, kp));
}, "permission-denied");
await rejects("sessions scope not covering the endpoint refuses (absent dimension is closed)", async () => {
  anchors.set("kscope", { ...anchors.get("k1")!, keyId: "kscope", scope: { sessions: ["other-endpoint"] } });
  await verify(mintSessionGrant({ space: SPACE, endpoint: ENDPOINT, holder: HOLDER, serving: SERVING, ttlMs: 60_000, issuerKeyId: "kscope", now: NOW }, kp));
}, "permission-denied");
await rejects("expired grant refuses", async () => verify(mint(), NOW + 60_001), "expired");
await rejects("not-yet-valid (nbf) refuses", async () => {
  const g = mint();
  const { sig: _s, ...unsigned } = g;
  await verify(signArtifact({ ...unsigned, nbf: NOW + 30_000 }, kp), NOW + 10);
}, "failed-precondition");
await rejects("TTL over the live ceiling refuses at mint", () => mint({ ttlMs: SESSION_GRANT_MAX_TTL_MS + 1 }), "contract-invalid");
await rejects("window out of bounds refuses at mint", () => mint({ window: SESSION_WINDOW_MAX + 1 }), "contract-invalid");

// ---------- B. ledger + redemption seam ----------
console.log("B. one-use redemption + finalize fresh-checks (faithful in-memory ledger)");

interface FakeState { rows: Map<string, SessionLedgerRow>; revoked: string[]; staged: number; released: string[]; alloc: number }
function fakeHooks(over: Partial<SessionRedemptionHooks> = {}): { hooks: SessionRedemptionHooks; st: FakeState } {
  const st: FakeState = { rows: new Map(), revoked: [], staged: 0, released: [], alloc: 0 };
  const ledger: SessionLedger = {
    createIssuing(row) {
      if (st.rows.has(row.sessionId)) return "exists";
      st.rows.set(row.sessionId, { ...row });
      return "created";
    },
    finalizeActive(id) {
      const r = st.rows.get(id);
      if (!r || r.state !== "issuing") return false;
      assertSessionStateTransition(r.state, "active");
      r.state = "active";
      return true;
    },
    transitionTerminal(id, to) {
      const r = st.rows.get(id);
      if (!r) return false;
      if ((["closed", "expired", "superseded", "retired"] as string[]).includes(r.state)) return false;
      assertSessionStateTransition(r.state, to);
      r.state = to;
      return true;
    },
  };
  const hooks: SessionRedemptionHooks = {
    ledger,
    holderProcessEpoch: () => HOLDER.processEpoch,
    servingEpoch: () => SERVING.epoch,
    allocateCredentialIds: () => {
      const n = ++st.alloc;
      return { credCaller: `cc${n}`, credServing: `cs${n}` };
    },
    // The lifecycle FENCE (default: gates hold). A gate-pinned stage that loses THROWS.
    stagePair: () => { st.staged++; },
    releaseCredential: (_id, credId) => { st.released.push(credId); return { id: credId, creds: `CREDS-${credId}` }; },
    revokeCredential: (id) => { st.revoked.push(id); },
    now: () => NOW + 10,
    ...over,
  };
  return { hooks, st };
}

{
  const g = await verify(mint());
  const { hooks, st } = fakeHooks();
  const holderCred = await redeemSession(g, hooks);
  const row = st.rows.get(g.sessionId)!;
  c("happy path: row active, BOTH ids recorded from creation, ONLY the holder credential released",
    row.state === "active" && row.credCaller === "cc1" && row.credServing === "cs1" && holderCred.id === "cc1" && st.released.join() === "cc1" && st.revoked.length === 0, { row, holderCred, released: st.released });
  c("the serving side retrieves ITS OWN credential separately (no cross-party bytes)",
    (await retrieveServingCredential(g.sessionId, row, hooks)).id === "cs1" && st.released.join() === "cc1,cs1", st.released);
  c("ledger key grammar", sessionLedgerKey(g.sessionId) === `session.${g.sessionId}`);

  // DUPLICATE redemption: the create-CAS is the one-use — the second attempt loses at the create
  // (before any staging), and the first row is untouched.
  await rejects("duplicate redemption loses the create-CAS (one-use burned)", () => redeemSession(g, hooks), "permission-denied");
  c("…the duplicate staged NOTHING new (the create is the one-use, before the stage)", st.staged === 1, st);
  c("…the winner's row is untouched", st.rows.get(g.sessionId)!.state === "active" && st.rows.get(g.sessionId)!.credCaller === "cc1");
}
{
  // retrieveServingCredential refuses on a non-active row (an issuing row confers nothing).
  const { hooks } = fakeHooks();
  await rejects("serving retrieval on a non-active row refuses (issuing confers nothing)",
    () => retrieveServingCredential("s", { state: "issuing", credServing: "csX" }, hooks), "failed-precondition");
}
{
  // The LIFECYCLE FENCE: a barrier retires a party during redemption, so the gate-pinned stage
  // LOSES (throws). The row is transitioned terminal and both ids revoked; nothing released.
  const g = await verify(mint());
  const { hooks, st } = fakeHooks({ stagePair: () => { throw new EpEnvelopeError("permission-denied", "lifecycle gate moved (barrier retired the holder)"); } });
  await rejects("a retired lifecycle makes the gate-pinned stage LOSE (the lifecycle fence, not a read)", () => redeemSession(g, hooks), "permission-denied");
  c("…row retired + both ids revoked + nothing released", st.rows.get(g.sessionId)!.state === "retired" && st.revoked.join() === "cc1,cs1" && st.released.length === 0, st);
}
{
  // HOLDER EPOCH drift at finalize (fresh-check): pre-check passes, second read moved.
  const g = await verify(mint());
  let reads = 0;
  const { hooks, st } = fakeHooks({ holderProcessEpoch: () => (++reads === 1 ? HOLDER.processEpoch : HOLDER.processEpoch + 1) });
  await rejects("holder restart during redemption refuses at the finalize fresh-check", () => redeemSession(g, hooks), "expired");
  c("…row went retired + both staged ids revoked, nothing released", st.rows.get(g.sessionId)!.state === "retired" && st.revoked.length === 2 && st.released.length === 0, st);
}
{
  // SERVING EPOCH drift at finalize → superseded.
  const g = await verify(mint());
  let reads = 0;
  const { hooks, st } = fakeHooks({ servingEpoch: () => (++reads === 1 ? SERVING.epoch : SERVING.epoch + 1) });
  await rejects("serving supersession during redemption refuses at finalize", () => redeemSession(g, hooks), "expired");
  c("…row went superseded + both staged ids revoked", st.rows.get(g.sessionId)!.state === "superseded" && st.revoked.length === 2, st);
}
{
  // REDEMPTION RACING A CLOSE: the row leaves `issuing` between the stage and the finalize — the
  // redemption loses its finalize CAS and releases nothing.
  const g = await verify(mint());
  const base = fakeHooks();
  const hooks: SessionRedemptionHooks = {
    ...base.hooks,
    stagePair: () => {
      base.st.staged++;
      // The racer closes the session exactly between the create/stage and the finalize.
      void base.hooks.ledger.transitionTerminal(g.sessionId, "closed");
    },
  };
  await rejects("a redemption racing a close loses its finalize (conflict), releases nothing", () => redeemSession(g, hooks), "conflict");
  c("…the racer's terminal state stands + the loser revoked both staged ids, released nothing", base.st.rows.get(g.sessionId)!.state === "closed" && base.st.revoked.length === 2 && base.st.released.length === 0, base.st);
}
{
  // PRE-CHECK refusals burn nothing: wrong holder epoch up front → no alloc, no create, no stage.
  const g = await verify(mint());
  const { hooks, st } = fakeHooks({ holderProcessEpoch: () => HOLDER.processEpoch + 5 });
  await rejects("an unredeemed grant does not survive the caller's restart (pre-check)", () => redeemSession(g, hooks), "expired");
  c("…nothing allocated/staged, one-use NOT burned", st.alloc === 0 && st.staged === 0 && st.rows.size === 0);
}
{
  // CRASH MID-ISSUE → the sweep collects: an `issuing` row past exp is transitioned expired
  // and BOTH recorded ids revoked; terminal + unexpired rows are untouched.
  const { hooks, st } = fakeHooks();
  const row: SessionLedgerRow = { sessionId: mintSessionId(), serving: SERVING, holder: { principal: HOLDER.id, lifecycleUid: HOLDER.lifecycleUid }, credCaller: "ccX", credServing: "csX", state: "issuing", exp: NOW };
  st.rows.set(row.sessionId, row);
  c("sweep collects a crashed half-issue past exp (row expired, BOTH ids revoked)",
    (await sweepSessionRow(row, hooks, { now: NOW + 1 })) === true && st.rows.get(row.sessionId)!.state === "expired" && st.revoked.join() === "ccX,csX", st);
  c("sweep never touches a terminal row", (await sweepSessionRow(st.rows.get(row.sessionId)!, hooks, { now: NOW + 999 })) === false);
  const live: SessionLedgerRow = { ...row, sessionId: mintSessionId(), state: "active", exp: NOW + 60_000 };
  st.rows.set(live.sessionId, live);
  c("sweep leaves an unexpired active row alone", (await sweepSessionRow(live, hooks, { now: NOW })) === false && live.state === "active");
}
{
  // State grammar monotonicity.
  let threw = 0;
  for (const [from, to] of [["closed", "active"], ["expired", "closed"], ["active", "issuing"], ["active", "active"]] as const) {
    try { assertSessionStateTransition(from as never, to as never); } catch { threw++; }
  }
  c("state grammar refuses terminal re-transition, re-entering issuing, double finalize", threw === 4);
}

// ---------- D. no standing EPS grant ----------
console.log("D. no standing EPS grant in any grant builder");
{
  const caller = { owner: "u_abc", actor: "worker", uid: "c".repeat(26) };
  const callerRows = epCallerGrantRows(SPACE, [{ endpoint: ENDPOINT, command: "run" }], caller);
  const serveRows = epServeGrantRows(SPACE, { endpoint: ENDPOINT, instanceId: SERVING.instanceId, epoch: SERVING.epoch, ephemeralCommands: ["run"] });
  const flat = JSON.stringify([callerRows, serveRows]);
  c("caller + serve grant rows carry NO eps subject (per-session credentials only, 13.9)", !flat.includes(".eps."), flat.slice(0, 200));
}

// ---------- C. the rails over a real broker ----------
console.log("C. rails: duplex windowed frames over a live broker");
const PORT = 20000 + Math.floor(Math.random() * 40000);
const sd = mkdtempSync(join(tmpdir(), "cotal-epsession-"));
const broker = spawn("nats-server", ["-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });
try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(`nats://127.0.0.1:${PORT}`); if (!up) await wait(100); }
  if (!up) throw new Error("broker did not come up");
  const ncA = await connect({ servers: `nats://127.0.0.1:${PORT}` }); // caller
  const ncB = await connect({ servers: `nats://127.0.0.1:${PORT}` }); // serving

  const grant = { space: SPACE, endpoint: ENDPOINT, sessionId: mintSessionId(), window: 4, serving: { epoch: SERVING.epoch } };
  {
    const gotB: unknown[] = []; const gotA: unknown[] = [];
    let aClosed = false;
    const serving = openSessionRail({ nc: ncB, grant, role: "serving", onData: (d) => gotB.push(d) });
    const caller = openSessionRail({ nc: ncA, grant, role: "caller", onData: (d) => gotA.push(d), onClose: () => { aClosed = true; } });
    await ncA.flush(); await ncB.flush();

    // Duplex, in order, MORE frames than the window (credits must cycle). A full window is
    // the DESIGN (resource-exhausted, no buffering): the sender retries when credits land.
    const sendRetry = async (rail: { send(d: unknown): number }, data: unknown) => {
      for (let attempt = 0; ; attempt++) {
        try { rail.send(data); return; } catch (e) {
          if (!(e instanceof EpEnvelopeError && e.code === "resource-exhausted") || attempt > 400) throw e;
          await wait(10);
        }
      }
    };
    for (let i = 1; i <= 12; i++) await sendRetry(caller, { i });
    for (let i = 1; i <= 6; i++) await sendRetry(serving, { echo: i });
    c("caller → serving: 12 frames through a window of 4, in order", await until(() => gotB.length === 12) && (gotB as { i: number }[]).every((v, idx) => v.i === idx + 1), gotB.length);
    c("serving → caller: frames flow the other way too", await until(() => gotA.length === 6) && (gotA as { echo: number }[])[5].echo === 6, gotA.length);
    c("window statistics are honest", caller.stats().sent === 12 && caller.stats().delivered === 6, caller.stats());

    // Advisory close: peer notified; local rail refuses further sends.
    serving.close();
    c("the in-band close reaches the peer (advisory)", await until(() => aClosed));
    await rejects("a closed rail refuses to send (failed-precondition)", () => { serving.send({ nope: 1 }); }, "failed-precondition");
    caller.close();
  }
  {
    // WINDOW OVERFLOW: no peer credits (bare counting subscriber, not a rail) — the 5th send
    // refuses resource-exhausted and NOTHING buffers.
    const g2 = { ...grant, sessionId: mintSessionId() };
    let seen = 0;
    const sub = ncB.subscribe(epsSubject(SPACE, ENDPOINT, g2.sessionId, SERVING.epoch, "in"), { callback: () => { seen++; } });
    await ncB.flush(); // subscription interest must reach the server before the sends
    const caller = openSessionRail({ nc: ncA, grant: g2, role: "caller", onData: () => {} });
    for (let i = 0; i < 4; i++) caller.send({ i });
    await rejects("window overflow refuses resource-exhausted (bounded, never buffered)", () => { caller.send({ overflow: true }); }, "resource-exhausted");
    await ncA.flush();
    c("exactly the window's frames were published (nothing queued past the refusal)", await until(() => seen === 4), seen);
    caller.close(); sub.unsubscribe();
  }
  {
    // GAP: a skipped seq breaks the session loudly; duplicates drop silently; a garbled frame
    // and a credit overrun surface as protocol errors.
    const g3 = { ...grant, sessionId: mintSessionId() };
    const errs: string[] = []; const got: number[] = [];
    const serving = openSessionRail({ nc: ncB, grant: g3, role: "serving", onData: (d) => got.push((d as { i: number }).i), onProtocolError: (r) => errs.push(r) });
    await ncB.flush();
    const inSubj = epsSubject(SPACE, ENDPOINT, g3.sessionId, SERVING.epoch, "in");
    ncA.publish(inSubj, encodeSessionFrame({ t: "f", seq: 1, data: { i: 1 } }));
    ncA.publish(inSubj, encodeSessionFrame({ t: "f", seq: 1, data: { i: 1 } })); // duplicate → drop
    ncA.publish(inSubj, encodeSessionFrame({ t: "f", seq: 3, data: { i: 3 } })); // GAP (2 missing)
    await ncA.flush();
    c("contiguous frame delivered once; duplicate dropped; gap surfaced as a protocol error",
      await until(() => errs.includes("gap")) && got.join() === "1", { got, errs });
    // ONE protocol error breaks the rail (further frames are ignored by design), so garbled
    // and credit-overrun each get a FRESH rail.
    const g4 = { ...grant, sessionId: mintSessionId() };
    const errs2: string[] = [];
    const caller = openSessionRail({ nc: ncA, grant: g4, role: "caller", onData: () => {}, onProtocolError: (r) => errs2.push(r) });
    await ncA.flush();
    ncB.publish(epsSubject(SPACE, ENDPOINT, g4.sessionId, SERVING.epoch, "out"), new TextEncoder().encode("not json"));
    await ncB.flush();
    c("a garbled frame surfaces as a protocol error and BREAKS the rail (fail-loud)", await until(() => errs2.includes("garbled-frame")), errs2);
    await rejects("a broken rail refuses to send", () => { caller.send({ x: 1 }); }, "failed-precondition");
    const g5 = { ...grant, sessionId: mintSessionId() };
    const errs3: string[] = [];
    const caller5 = openSessionRail({ nc: ncA, grant: g5, role: "caller", onData: () => {}, onProtocolError: (r) => errs3.push(r) });
    await ncA.flush();
    ncB.publish(epsSubject(SPACE, ENDPOINT, g5.sessionId, SERVING.epoch, "out"), encodeSessionFrame({ t: "credit", ack: 99 })); // acks more than ever sent
    await ncB.flush();
    c("a credit overrun (ack past anything sent) surfaces as a protocol error", await until(() => errs3.includes("credit-overrun")), errs3);
    serving.close(); caller.close(); caller5.close();
  }
  {
    // CREDIT LOSS RECOVERY — mechanism (a) PIGGYBACK: a sender at a full window recovers when a
    // reverse DATA frame carries a piggybacked absolute ack, even with NO standalone credit frame
    // (the dedicated credit was "lost"). window=2; fill it; inject one data frame on the caller's
    // ingress carrying ack:2; the window reopens and the next send succeeds.
    const g6 = { ...grant, sessionId: mintSessionId(), window: 2 };
    const outSubj = epsSubject(SPACE, ENDPOINT, g6.sessionId, SERVING.epoch, "out");
    const caller = openSessionRail({ nc: ncA, grant: g6, role: "caller", onData: () => {}, idleCreditMs: 0, stallTimeoutMs: 60_000 });
    await ncA.flush();
    caller.send({ i: 1 }); caller.send({ i: 2 });
    await rejects("window full before any ack (resource-exhausted)", () => { caller.send({ i: 3 }); }, "resource-exhausted");
    ncB.publish(outSubj, encodeSessionFrame({ t: "f", seq: 1, data: { echo: 1 }, ack: 2 })); // reverse data PIGGYBACKS ack:2
    await ncB.flush();
    c("a piggybacked ack on reverse data reopens the window (a lost standalone credit self-heals)",
      await until(() => caller.stats().ackedThrough === 2) && caller.send({ i: 3 }) === 3, caller.stats());
    caller.close();
  }
  {
    // CREDIT LOSS RECOVERY — mechanism (b) IDLE RE-EMIT: a receiver holding ungranted delivery
    // (below the standalone credit threshold) whose peer has gone quiet re-advertises its absolute
    // watermark on the idle timer, so a double-credit-loss stall self-heals. window big enough that
    // one delivered frame never hits the standalone threshold; assert a credit appears anyway.
    const g8 = { ...grant, sessionId: mintSessionId(), window: 16 };
    const inSubj = epsSubject(SPACE, ENDPOINT, g8.sessionId, SERVING.epoch, "in");
    const outSubj = epsSubject(SPACE, ENDPOINT, g8.sessionId, SERVING.epoch, "out");
    const credits: number[] = [];
    const watch = ncA.subscribe(outSubj, { callback: (_e, msg) => { const f = parseSessionFrame(msg.data); if (f.t === "credit") credits.push(f.ack); } });
    const serving = openSessionRail({ nc: ncB, grant: g8, role: "serving", onData: () => {}, idleCreditMs: 30, stallTimeoutMs: 60_000 });
    await ncA.flush(); await ncB.flush();
    ncA.publish(inSubj, encodeSessionFrame({ t: "f", seq: 1, data: { i: 1 } })); // 1 < creditEvery(8): no standalone threshold credit
    await ncA.flush();
    c("the idle re-emit re-advertises the absolute watermark for a quiet peer (double-loss self-heal)",
      await until(() => credits.includes(1), 3000), credits);
    serving.close(); watch.unsubscribe();
  }
  {
    // STALL WATCHDOG: no credits AT ALL (bare subscriber, no reverse traffic, no idle re-emit
    // reaching us), a full window, and a short stall timeout with an injected clock — the next
    // send past the timeout surfaces a DETECTABLE `stall` fault, never a silent hang.
    const g7 = { ...grant, sessionId: mintSessionId(), window: 2 };
    let clock = NOW;
    const errs: string[] = [];
    const sub = ncB.subscribe(epsSubject(SPACE, ENDPOINT, g7.sessionId, SERVING.epoch, "in"), { callback: () => {} });
    await ncB.flush();
    const caller = openSessionRail({ nc: ncA, grant: g7, role: "caller", onData: () => {}, onProtocolError: (r) => errs.push(r), idleCreditMs: 0, stallTimeoutMs: 1000, now: () => clock });
    caller.send({ i: 1 }); caller.send({ i: 2 }); // window full
    await rejects("a full window still refuses resource-exhausted (transient) before the stall timeout", () => { caller.send({ i: 3 }); }, "resource-exhausted");
    clock += 2000; // past the stall timeout with no credit advance
    await rejects("past the stall timeout the send surfaces a DETECTABLE fault (not a silent hang)", () => { caller.send({ i: 3 }); }, "failed-precondition");
    c("…the stall fired as a protocol error (session-fault, re-establish)", errs.includes("stall"), errs);
    caller.close(); sub.unsubscribe();
  }
  {
    // Frame parse grammar (closed schema) + payload ceiling.
    let threw = 0;
    for (const bad of [{ t: "f", seq: 0, data: 1 }, { t: "f", seq: 1 }, { t: "credit" }, { t: "close", x: 1 }, { t: "??" }, { t: "f", seq: 1, data: 1, x: 2 }, { t: "f", seq: 1, data: 1, ack: -1 }])
      try { parseSessionFrame(encodeSessionFrame(bad as never)); } catch { threw++; }
    c("frame grammar is a closed schema (7 malformed shapes refuse, incl. a bad piggyback ack)", threw === 7);
    // A valid piggybacked ack round-trips.
    const rt = parseSessionFrame(encodeSessionFrame({ t: "f", seq: 3, data: { x: 1 }, ack: 2 }));
    c("a data frame with a valid piggybacked ack parses", rt.t === "f" && rt.seq === 3 && rt.ack === 2);
    const tiny = openSessionRail({ nc: ncA, grant: { ...grant, sessionId: mintSessionId() }, role: "caller", onData: () => {}, maxPayloadBytes: 64 });
    await rejects("a frame over the payload ceiling refuses at SEND (preflight)", () => { tiny.send({ big: "x".repeat(100) }); }, "contract-invalid");
    tiny.close();
  }

  await ncA.drain().catch(() => {});
  await ncB.drain().catch(() => {});
  console.log(`\nENDPOINT SESSION SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${ok} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).message);
  process.exitCode = 1;
} finally {
  broker.kill("SIGKILL");
  rmSync(sd, { recursive: true, force: true });
}
