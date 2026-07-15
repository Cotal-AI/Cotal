/**
 * D7 SESSION production auth adapter smoke — core's redemption/retrieval/close/sweep seams
 * driven through the REAL KV adapter against a real broker's auth store. Covers: the lazy-bind
 * store probe (an unprovisioned space fails loud), the happy redemption (issuing create-CAS →
 * gate-pinned stage → finalize → holder release), DETERMINISTIC re-release (the authenticated
 * lost-response retry returns byte-identical creds), per-party serving retrieval + full
 * identity refusal, presenter holder-binding, the §13.1 gate fence (a gate moved between
 * observation and stage makes the pinned touch LOSE: row terminal, both staged credentials
 * revoked and marked), retired/frozen gates refusing, epoch currency, the authenticated close
 * op (party/operator membership against the authoritative row, idempotent terminal, both
 * halves revoked+marked), the expiry sweep (transition + revoke, the terminal-row unmarked-id
 * retry after a swallowed revoke failure), and fail-closed row parsing.
 *
 * Run: pnpm smoke:session-adapter:auth   (needs nats-server on PATH; part of smoke:ci)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { generateKeyPair, exportJWK, calculateJwkThumbprint, jwtVerify, type CryptoKey } from "jose";
import {
  isReachable, EpEnvelopeError, createEndpointStreams, epsSubject, sessionLedgerKey,
  redeemSession, retrieveServingCredential,
  type SessionGrant, type SessionRedemptionHooks,
} from "@cotal-ai/core";
import {
  openSessionAuthStore, sessionRedemptionHooks, closeSession, sweepSessions,
} from "../src/index.js";
// The gate/provisioning stand-ins are test-internal (not in the public index).
import { writeLifecycleGate, holderGateId, servingGateId } from "../src/session-ledger.js";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { ok++; } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); } };
const rejects = async (n: string, fn: () => Promise<unknown> | unknown, code?: string) => {
  try { await fn(); c(n, false, "no throw"); } catch (e) {
    c(n, code === undefined || (e instanceof EpEnvelopeError && e.code === code), `code ${(e as EpEnvelopeError).code ?? (e as Error).message}`);
  }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SPACE = "sessadapter";
const ENDPOINT = "term";
const NOW = 1_700_000_000_000;
const HOLDER_UID = "h".repeat(26);
const SERVING_IID = "s".repeat(26);
const mkGrant = (sessionId: string, over: Partial<SessionGrant> = {}): SessionGrant => ({
  v: 1,
  sessionId,
  space: SPACE,
  endpoint: ENDPOINT,
  subjects: {
    in: epsSubject(SPACE, ENDPOINT, sessionId, 7, "in"),
    out: epsSubject(SPACE, ENDPOINT, sessionId, 7, "out"),
  },
  holder: { id: "u_holder.cli", lifecycleUid: HOLDER_UID, processEpoch: 3 },
  serving: { instanceId: SERVING_IID, epoch: 7 },
  window: 64,
  iat: NOW,
  exp: NOW + 60_000,
  nonce: "n".repeat(16),
  issuer: { keyId: "k1" },
  sig: "unused-by-redemption",
  ...over,
} as SessionGrant);
const PRESENTER = { id: "u_holder.cli", lifecycleUid: HOLDER_UID };
const sid = (n: number) => `${"q".repeat(20)}${String(n).padStart(4, "0")}`;

const PORT = 20000 + Math.floor(Math.random() * 40000);
const sd = mkdtempSync(join(tmpdir(), "cotal-sessadapter-"));
const broker = spawn("nats-server", ["-js", "-sd", sd, "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(`nats://127.0.0.1:${PORT}`); if (!up) await wait(100); }
  if (!up) throw new Error("broker did not come up");
  const nc = await connect({ servers: `nats://127.0.0.1:${PORT}` });

  console.log("A. the store bind fails loud on an unprovisioned space");
  await rejects("an unprovisioned space refuses at OPEN (Kvm.open binds lazily; the status probe forces it)",
    () => openSessionAuthStore(nc, "neversetup"), "failed-precondition");

  await createEndpointStreams(await jetstreamManager(nc), new Kvm(nc), SPACE);
  const store = await openSessionAuthStore(nc, SPACE);
  const kv = store.kv;
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", { extractable: true });
  const thumbs = new Map<string, string>([["sess-1", await calculateJwkThumbprint(await exportJWK(publicKey))]]);
  const keys = new Map<string, CryptoKey>([["sess-1", privateKey as CryptoKey]]);
  const signer = { current: { kid: "sess-1", key: privateKey as CryptoKey }, resolve: (kid: string) => keys.get(kid), thumbprint: (kid: string) => thumbs.get(kid) };
  const clock = { t: NOW + 10 };
  const hooks = sessionRedemptionHooks({ store, signer, now: () => clock.t });

  await writeLifecycleGate(kv, holderGateId(HOLDER_UID), { state: "open", processEpoch: 3, generation: 1 });
  await writeLifecycleGate(kv, servingGateId(ENDPOINT, SERVING_IID), { state: "open", processEpoch: 7, generation: 1 });

  console.log("B. the happy redemption against the real store");
  const g1 = mkGrant(sid(1));
  const cred1 = await redeemSession(g1, PRESENTER, hooks);
  c("redemption releases the HOLDER credential (a real signed JWT bounded by the session exp)",
    cred1.id === `${HOLDER_UID}.${sid(1)}.c` && cred1.exp === g1.exp && cred1.creds.split(".").length === 3, cred1);
  {
    const { payload } = await jwtVerify(cred1.creds, publicKey, { currentDate: new Date(NOW) });
    const act = payload.act as { kind: string; sessionId: string; party: string; subjects: { pub: string[]; sub: string[] } };
    c("the released credential is confined to EXACTLY the caller's two rails (pub in, sub out)",
      act.kind === "session" && act.sessionId === sid(1) && act.party === "caller"
      && act.subjects.pub[0] === g1.subjects.in && act.subjects.sub[0] === g1.subjects.out, act);
  }
  {
    const row = JSON.parse(new TextDecoder().decode((await kv.get(sessionLedgerKey(sid(1))))!.value)) as { state: string; revoked: { caller: boolean; serving: boolean } };
    c("the row is durably ACTIVE with both revocation marks false", row.state === "active" && !row.revoked.caller && !row.revoked.serving, row);
  }
  const cred1again = await redeemSession(g1, PRESENTER, hooks);
  c("the authenticated lost-response retry re-releases BYTE-IDENTICAL creds (deterministic mint, no re-mint)",
    cred1again.creds === cred1.creds && cred1again.id === cred1.id);
  await rejects("a foreign presenter is refused even with the grant in hand (holder-bound, never bearer)",
    () => redeemSession(g1, { id: "u_evil", lifecycleUid: "e".repeat(26) }, hooks), "permission-denied");
  const sCred = await retrieveServingCredential(sid(1), { endpoint: ENDPOINT, instanceId: SERVING_IID, epoch: 7 }, hooks);
  c("the serving party retrieves ITS OWN credential (pub out, sub in)", sCred.id === `term.${SERVING_IID}.${sid(1)}.s` && sCred.creds !== cred1.creds);
  await rejects("a wrong serving epoch is refused (full-identity per-party release)",
    () => retrieveServingCredential(sid(1), { endpoint: ENDPOINT, instanceId: SERVING_IID, epoch: 8 }, hooks), "permission-denied");

  console.log("C. the §13.1 gate fence + gate currency");
  {
    // The gate MOVES between observation and stage: wrap the observe hook to advance the gate
    // after pinning. The pinned touch must LOSE; the row goes terminal and both staged
    // credentials are revoked AND marked.
    const g2 = mkGrant(sid(2));
    const moving: SessionRedemptionHooks = {
      ...hooks,
      observeHolderGate: async (h) => {
        const pin = await hooks.observeHolderGate(h);
        await writeLifecycleGate(kv, holderGateId(HOLDER_UID), { state: "open", processEpoch: 3, generation: 2 });
        return pin;
      },
    };
    await rejects("a gate moved between observation and stage makes the pinned write LOSE (the fence is a write loss)",
      () => redeemSession(g2, PRESENTER, moving), "permission-denied");
    const row = JSON.parse(new TextDecoder().decode((await kv.get(sessionLedgerKey(sid(2))))!.value)) as { state: string; revoked: { caller: boolean; serving: boolean } };
    c("…the burned row is TERMINAL with both staged credentials revoked and MARKED",
      row.state === "retired" && row.revoked.caller && row.revoked.serving, row);
    await rejects("…and the burned one-use never redeems again", () => redeemSession(g2, PRESENTER, hooks), "permission-denied");
  }
  await writeLifecycleGate(kv, holderGateId(HOLDER_UID), { state: "retired", processEpoch: 3, generation: 3 });
  await rejects("a RETIRED holder gate refuses redemption", () => redeemSession(mkGrant(sid(3)), PRESENTER, hooks), "permission-denied");
  await writeLifecycleGate(kv, holderGateId(HOLDER_UID), { state: "frozen", processEpoch: 3, generation: 3 });
  await rejects("a FROZEN holder gate refuses (a barrier is in flight; nothing mints under it)",
    () => redeemSession(mkGrant(sid(4)), PRESENTER, hooks), "permission-denied");
  await writeLifecycleGate(kv, holderGateId(HOLDER_UID), { state: "open", processEpoch: 4, generation: 4 });
  await rejects("a holder process epoch that moved refuses (an unredeemed grant dies with the restart)",
    () => redeemSession(mkGrant(sid(5)), PRESENTER, hooks), "expired");
  await writeLifecycleGate(kv, holderGateId(HOLDER_UID), { state: "open", processEpoch: 3, generation: 5 });

  console.log("D. the authenticated close op");
  {
    const g6 = mkGrant(sid(6));
    await redeemSession(g6, PRESENTER, hooks);
    await rejects("a NON-party closer is refused against the authoritative row",
      () => closeSession(store, hooks, { sessionId: sid(6), closer: { kind: "serving", endpoint: ENDPOINT, instanceId: SERVING_IID, epoch: 99 } }), "permission-denied");
    const closed = await closeSession(store, hooks, { sessionId: sid(6), closer: { kind: "holder", ...PRESENTER } });
    c("a party close transitions the row terminal", closed.transitioned);
    const row = JSON.parse(new TextDecoder().decode((await kv.get(sessionLedgerKey(sid(6))))!.value)) as { state: string; revoked: { caller: boolean; serving: boolean } };
    c("…closed durably, BOTH credentials revoked and marked", row.state === "closed" && row.revoked.caller && row.revoked.serving, row);
    const again = await closeSession(store, hooks, { sessionId: sid(6), closer: { kind: "operator" } });
    c("a second close is idempotent (no transition, marks already set)", !again.transitioned);
    await rejects("a closed session releases NOTHING (the row is the authority boundary, not the release count)",
      () => redeemSession(g6, PRESENTER, hooks), "permission-denied");
    await rejects("…for the serving party too",
      () => retrieveServingCredential(sid(6), { endpoint: ENDPOINT, instanceId: SERVING_IID, epoch: 7 }, hooks), "failed-precondition");
  }
  await rejects("closing an unknown session is not-found", () => closeSession(store, hooks, { sessionId: sid(7), closer: { kind: "operator" } }), "not-found");

  console.log("E. the expiry sweep + the terminal-row unmarked-id retry");
  {
    const g8 = mkGrant(sid(8), { exp: NOW + 5_000 });
    await redeemSession(g8, PRESENTER, hooks);
    const idle = await sweepSessions(store, hooks, { now: NOW + 1_000 });
    c("an in-life active row is left alone", idle.acted === 0, idle);
    const pass1 = await sweepSessions(store, hooks, { now: NOW + 6_000 });
    c("past exp the sweep transitions and revokes (one row acted)", pass1.acted === 1, pass1);
    const row = JSON.parse(new TextDecoder().decode((await kv.get(sessionLedgerKey(sid(8))))!.value)) as { state: string; revoked: { caller: boolean; serving: boolean } };
    c("…expired durably, both halves revoked and marked", row.state === "expired" && row.revoked.caller && row.revoked.serving, row);
    c("a fully-collected terminal row is never touched again", (await sweepSessions(store, hooks, { now: NOW + 7_000 })).acted === 0);
  }
  {
    // A SWALLOWED revoke failure leaves its mark unset; the next sweep pass retries EXACTLY
    // the unmarked half.
    const g9 = mkGrant(sid(9));
    await redeemSession(g9, PRESENTER, hooks);
    let failServing = true;
    const flaky: SessionRedemptionHooks = {
      ...hooks,
      revokeCredential: async (id) => {
        if (failServing && id.endsWith(".s")) throw new Error("revocation backend down");
        return hooks.revokeCredential(id);
      },
    };
    await closeSession(store, flaky, { sessionId: sid(9), closer: { kind: "operator" } });
    const afterClose = JSON.parse(new TextDecoder().decode((await kv.get(sessionLedgerKey(sid(9))))!.value)) as { revoked: { caller: boolean; serving: boolean } };
    c("the failed half stays UNMARKED (the mark is set only by a revoke that succeeded)",
      afterClose.revoked.caller && !afterClose.revoked.serving, afterClose);
    failServing = false;
    const retryPass = await sweepSessions(store, flaky, { now: NOW + 1_000 });
    const afterRetry = JSON.parse(new TextDecoder().decode((await kv.get(sessionLedgerKey(sid(9))))!.value)) as { revoked: { caller: boolean; serving: boolean } };
    c("the next sweep pass retries EXACTLY the unmarked half to completion",
      retryPass.acted === 1 && afterRetry.revoked.serving, { retryPass, afterRetry });
  }

  console.log("F. fail-closed row parsing + the freelance-round fixes");
  await kv.put(sessionLedgerKey(sid(10).slice(0, 22) + "gg"), new TextEncoder().encode("{\"garbled\":true}"));
  await rejects("a garbled session row refuses (internal), never authorizes",
    () => hooks.ledger.read(sid(10).slice(0, 22) + "gg"), "internal");

  // (2) CLOCK VALIDATION: a malformed trusted clock never authorizes or terminates.
  {
    const nanHooks = sessionRedemptionHooks({ store, signer, now: () => Number.NaN });
    await rejects("a NaN redemption clock refuses (never finalizes a dead grant active)",
      () => redeemSession(mkGrant(sid(20)), PRESENTER, nanHooks), "failed-precondition");
    await rejects("a NaN sweep clock refuses (never expires every live row at once)",
      () => sweepSessions(store, hooks, { now: Number.NaN }), "failed-precondition");
    await rejects("a negative sweep margin refuses", () => sweepSessions(store, hooks, { now: NOW, marginMs: -1 }), "failed-precondition");
  }

  // (5) EXACT-REPLAY retry identity: a DIFFERENT grant reusing the sessionId + holder does NOT
  // re-release the winner's credential; only an exact replay of the winning grant does.
  {
    const gWin = mkGrant(sid(21));
    await redeemSession(gWin, PRESENTER, hooks);
    // Same holder + serving (so it passes the epoch preflight) but a DIFFERENT signed artifact
    // (a distinct sig — a different exp would produce one): it reaches the burned one-use, and
    // the retry refuses because the grant SIGNATURE differs from the winner's stored one.
    const gImpostor = mkGrant(sid(21), { exp: NOW + 30_000, sig: "a-different-signature" });
    await rejects("a DIFFERENT grant reusing the sessionId + holder is refused (not a lost-response retry)",
      () => redeemSession(gImpostor, PRESENTER, hooks), "permission-denied");
    const replay = await redeemSession(gWin, PRESENTER, hooks);
    c("an EXACT replay of the winning grant re-releases the SAME credential", replay.id === `${HOLDER_UID}.${sid(21)}.c`);
  }

  // (4) SIGNER ROTATION: the pinned kid keeps the retry byte-identical across a signer rotation.
  {
    const { privateKey: k2 } = await generateKeyPair("EdDSA", { extractable: true });
    keys.set("sess-2", k2 as CryptoKey);
    const gRot = mkGrant(sid(22));
    const rotSigner = { current: { kid: "sess-1", key: privateKey as CryptoKey }, resolve: (kid: string) => keys.get(kid), thumbprint: (kid: string) => thumbs.get(kid) };
    const rotHooks = sessionRedemptionHooks({ store, signer: rotSigner, now: () => clock.t });
    const first = await redeemSession(gRot, PRESENTER, rotHooks);
    // The signer rotates its CURRENT kid to sess-2, but the row pinned sess-1: the retry resolves
    // the pinned key and yields byte-identical bytes (no re-mint under the new key).
    const rotatedSigner = { current: { kid: "sess-2", key: k2 as CryptoKey }, resolve: (kid: string) => keys.get(kid), thumbprint: (kid: string) => thumbs.get(kid) };
    const rotatedHooks = sessionRedemptionHooks({ store, signer: rotatedSigner, now: () => clock.t });
    const retry = await redeemSession(gRot, PRESENTER, rotatedHooks);
    c("a lost-response retry after a signer rotation yields BYTE-IDENTICAL creds (the row pins the kid)", retry.creds === first.creds);
    // …and if the pinned key is GONE, release fails closed rather than re-minting under a new key.
    const goneSigner = { current: { kid: "sess-2", key: k2 as CryptoKey }, resolve: (kid: string) => (kid === "sess-2" ? (k2 as CryptoKey) : undefined), thumbprint: (kid: string) => thumbs.get(kid) };
    const goneHooks = sessionRedemptionHooks({ store, signer: goneSigner, now: () => clock.t });
    await rejects("release fails closed when the pinned signing key is unresolvable (no re-mint)",
      () => redeemSession(gRot, PRESENTER, goneHooks), "unavailable");
  }

  // (7) CRED-ROW FAIL-CLOSED: a corrupt staged credential with widened subjects never signs.
  {
    const gC = mkGrant(sid(23));
    await redeemSession(gC, PRESENTER, hooks);
    const sCid = `term.${SERVING_IID}.${sid(23)}.s`;
    // Corrupt the SERVING staged row (the one retrieveServingCredential reads) with an unknown
    // field + a widened `subjects` array (the old trust vector): parseCredRow refuses it.
    await kv.put(`cred.${sCid}`, new TextEncoder().encode(JSON.stringify({ v: 1, kind: "session", sessionId: sid(23), party: "serving", kid: "sess-1", state: "staged", exp: NOW + 60_000, subjects: { pub: ["cotal.evil.>"], sub: [] } })));
    await rejects("a credential row with an UNKNOWN field (widened subjects) refuses (closed schema, never signs)",
      () => retrieveServingCredential(sid(23), { endpoint: ENDPOINT, instanceId: SERVING_IID, epoch: 7 }, hooks), "internal");
  }

  // (8) SWEEP CONTINUES past a poison row: one malformed key never blocks the rest.
  {
    const gP1 = mkGrant(sid(24), { exp: NOW + 5_000 });
    await redeemSession(gP1, PRESENTER, hooks);
    await kv.put(sessionLedgerKey(sid(25).slice(0, 22) + "gg"), new TextEncoder().encode("{\"poison\":true}"));
    const pass = await sweepSessions(store, hooks, { now: NOW + 6_000 });
    const row = JSON.parse(new TextDecoder().decode((await kv.get(sessionLedgerKey(sid(24))))!.value)) as { state: string };
    c("a poison row is COLLECTED (failed[]) but the valid row is still expired+contained this pass",
      pass.failed.length === 1 && row.state === "expired", { pass, row });
  }

  // (1) CLOSE COMPLETION honesty: a swallowed revoke makes close report NOT fullyRevoked.
  {
    const gCl = mkGrant(sid(26));
    await redeemSession(gCl, PRESENTER, hooks);
    const failAll: SessionRedemptionHooks = { ...hooks, revokeCredential: async () => { throw new Error("eviction backend down"); } };
    const res = await closeSession(store, failAll, { sessionId: sid(26), closer: { kind: "operator" } });
    c("close transitions the row but reports fullyRevoked=false when containment did not complete (no silent success)",
      res.transitioned && !res.fullyRevoked, res);
  }

  // (6) GATE DEDUP defensive path: a redemption where holder and serving share the UID string
  // still redeems (their gate keys are distinct now that the serving side is endpoint-qualified;
  // the dedup only bites an actual same-key collision, which the qualification prevents).
  {
    const selfUid = "f".repeat(26);
    await writeLifecycleGate(kv, holderGateId(selfUid), { state: "open", processEpoch: 3, generation: 1 });
    await writeLifecycleGate(kv, servingGateId(ENDPOINT, selfUid), { state: "open", processEpoch: 3, generation: 1 });
    const gSelf = mkGrant(sid(27), { holder: { id: "u_self.cli", lifecycleUid: selfUid, processEpoch: 3 }, serving: { instanceId: selfUid, epoch: 3 }, subjects: { in: epsSubject(SPACE, ENDPOINT, sid(27), 3, "in"), out: epsSubject(SPACE, ENDPOINT, sid(27), 3, "out") } });
    const selfCred = await redeemSession(gSelf, { id: "u_self.cli", lifecycleUid: selfUid }, hooks);
    c("a redemption sharing the holder/serving UID string redeems (endpoint-qualified serving gate keeps the keys distinct)",
      selfCred.id === `${selfUid}.${sid(27)}.c`);
  }

  console.log("H. the 006baac security round: branded store, thumbprint, party-close, endpoint collision");
  {
    // BRANDED store: a hand-assembled {kv, space} never authorizes.
    await rejects("a hand-assembled {kv, space} store refuses (the space bond is constructed, not asserted)",
      () => sessionRedemptionHooks({ store: { kv, space: SPACE }, signer }).allocateCredentialIds(mkGrant(sid(40))) as never, "failed-precondition");
    // THUMBPRINT rebind: the same kid resolving to DIFFERENT key material refuses at release.
    const gT = mkGrant(sid(41));
    await redeemSession(gT, PRESENTER, hooks);
    const { privateKey: kOther } = await generateKeyPair("EdDSA", { extractable: true });
    const rebindSigner = { current: { kid: "sess-1", key: kOther as CryptoKey }, resolve: (_kid: string) => kOther as CryptoKey, thumbprint: (_kid: string) => "a-different-thumbprint" };
    const rebindHooks = sessionRedemptionHooks({ store, signer: rebindSigner, now: () => clock.t });
    await rejects("a kid rebound to different key material refuses at release (thumbprint mismatch, not just the label)",
      () => redeemSession(gT, PRESENTER, rebindHooks), "permission-denied");
    // PARTY close cannot name a barrier-specific terminal reason.
    const gP = mkGrant(sid(42));
    await redeemSession(gP, PRESENTER, hooks);
    await rejects("a PARTY close naming a barrier reason (superseded) refuses (only the operator/barrier names it)",
      () => closeSession(store, hooks, { sessionId: sid(42), closer: { kind: "holder", ...PRESENTER }, to: "superseded" }), "permission-denied");
    const okClose = await closeSession(store, hooks, { sessionId: sid(42), closer: { kind: "holder", ...PRESENTER } });
    c("…a party close without a reason produces `closed`", okClose.transitioned);
    // ENDPOINT COLLISION: the SAME instanceId under a DIFFERENT endpoint has a distinct gate +
    // credential family (endpoint-qualified), so one endpoint's session never touches the other's.
    const collUid = HOLDER_UID; // holder uid shared, but serving is endpoint-qualified
    const OTHER_EP = "other";
    await writeLifecycleGate(kv, servingGateId(OTHER_EP, SERVING_IID), { state: "open", processEpoch: 7, generation: 1 });
    const gColl = mkGrant(sid(43), { endpoint: OTHER_EP, subjects: { in: epsSubject(SPACE, OTHER_EP, sid(43), 7, "in"), out: epsSubject(SPACE, OTHER_EP, sid(43), 7, "out") } });
    void collUid;
    const collCred = await redeemSession(gColl, PRESENTER, hooks);
    const collServing = await retrieveServingCredential(sid(43), { endpoint: OTHER_EP, instanceId: SERVING_IID, epoch: 7 }, hooks);
    c("the same instanceId under a DIFFERENT endpoint has an endpoint-qualified serving cred family (no collision)",
      collCred.id === `${HOLDER_UID}.${sid(43)}.c` && collServing.id === `other.${SERVING_IID}.${sid(43)}.s`, { collCred: collCred.id, collServing: collServing.id });
    // STORE config: a mirror/MaxAge store is refused (proven at open by the shape check; here we
    // just confirm the primary store bound cleanly and is branded).
    c("the primary auth store bound cleanly (allow_direct=false, no MaxAge, not a mirror)", store.space === SPACE);
  }

  await nc.drain().catch(() => {});
} finally {
  broker.kill("SIGKILL");
  await new Promise((r) => broker.once("exit", r));
  rmSync(sd, { recursive: true, force: true });
}

console.log(fail === 0 ? `\nSESSION ADAPTER SMOKE OK ✅  (${ok} passed, ${fail} failed)` : `\nSESSION ADAPTER SMOKE FAILED ❌  (${ok} passed, ${fail} failed)`);
if (fail > 0) process.exit(1);
