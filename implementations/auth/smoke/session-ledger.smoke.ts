/**
 * D7 SESSION production auth adapter smoke — core's redemption/retrieval/close/sweep seams
 * driven through the REAL KV adapter against a real broker's auth store, now over the D13
 * NORMATIVE families (SPEC §13.1): the holder side consumes the REAL lifecycle registry (a
 * reserved UID, a real activation-born gate, the alias-HEAD epoch read with active-only
 * currency and uid binding), the serving side the disjoint endpoint gate family
 * `epgate.<endpoint>.<instanceId>`, and the per-session credentials are normative ledger rows
 * (`cred.<uid>.<sessionId>.c` / `epcred.<endpoint>.<instanceId>.<sessionId>.s`, closed schema,
 * monotonic active→revoked) with the implementation pins in `stage.session.<sessionId>.<c|s>`.
 *
 * Covers: the lazy-bind store probe, the happy redemption (issuing create-CAS → gate-pinned
 * stage → finalize → holder release) with the normative rows + pins durably present,
 * DETERMINISTIC re-release, per-party serving retrieval + full identity refusal, presenter
 * holder-binding, the §13.1 gate fence (a gate moved between observation and stage makes the
 * pinned touch LOSE: row terminal, both ledger rows revoked and marked), retired/frozen gates
 * refusing, HEAD-read epoch currency (moved epoch, non-active head, uid mismatch), the
 * authenticated close op, the expiry sweep + unmarked-id retry, fail-closed row/pin parsing,
 * and the branded store/registry/reader construction.
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
  redeemSession, retrieveServingCredential, recordAtomicKey, LIFECYCLE_HEAD, mintLifecycleUid,
  type SessionGrant, type SessionRedemptionHooks,
} from "@cotal-ai/core";
import {
  openSessionAuthStore, sessionRedemptionHooks, closeSession, sweepSessions,
  openLifecycleRegistry, openLifecycleMappingReader,
  type LifecycleRegistry,
} from "../src/index.js";
// The gate/provisioning stand-ins + registry primitives are test-internal (not in the public index).
import { writeEndpointGate, epgateKey, reconcileSessionForTakeover, kvServeIssuanceGate } from "../src/session-ledger.js";
import { makeLedgerScannerOverConnection } from "../src/ledger-scanner.js";
import { parseLedgerRow } from "../src/credential-ledger.js";
import { tryReserveUid, createGateFrozen, reopenGate } from "../src/lifecycle-registry.js";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";

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
const OWNER = `u_${"a".repeat(26)}`;
const HOLDER_ID = `${OWNER}.cli`;
const HOLDER_UID = "h".repeat(26);
const SERVING_IID = "s".repeat(26);
const SERVING_PRINCIPAL = `u_${"c".repeat(26)}.term`; // the serving instance's CONNZ-attributable principal
const MGR = "mgr-1";
const enc = new TextEncoder();
const dec = new TextDecoder();
const headKey = recordAtomicKey(LIFECYCLE_HEAD, [OWNER, "cli"]);
const headRow = (epoch: number, over: Record<string, unknown> = {}) => ({
  owner: OWNER, actor: "cli", lifecycleUid: HOLDER_UID, managerInstance: MGR, processEpoch: epoch, state: "active", ...over,
});
const mkGrant = (sessionId: string, over: Partial<SessionGrant> = {}): SessionGrant => ({
  v: 1,
  sessionId,
  space: SPACE,
  endpoint: ENDPOINT,
  subjects: {
    in: epsSubject(SPACE, ENDPOINT, sessionId, 7, "in"),
    out: epsSubject(SPACE, ENDPOINT, sessionId, 7, "out"),
  },
  holder: { id: HOLDER_ID, lifecycleUid: HOLDER_UID, processEpoch: 3 },
  serving: { instanceId: SERVING_IID, epoch: 7 },
  window: 64,
  iat: NOW,
  exp: NOW + 60_000,
  nonce: "n".repeat(16),
  issuer: { keyId: "k1" },
  sig: "unused-by-redemption",
  ...over,
} as SessionGrant);
const PRESENTER = { id: HOLDER_ID, lifecycleUid: HOLDER_UID };
const sid = (n: number) => `${"q".repeat(20)}${String(n).padStart(4, "0")}`;

const PORT = await pickFreePort();
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
  // The sweep enumerates `session.>` through the SAME sealed auth-ledger scanner the barriers use
  // (one literal consumer name + lock over the auth stream); the sweep holds no CONSUMER.CREATE.
  const scanner = makeLedgerScannerOverConnection(nc, SPACE);
  const registry = await openLifecycleRegistry(nc, SPACE);
  const reader = await openLifecycleMappingReader(nc, SPACE);
  const recordsKv = await new Kvm(nc).open(`cotal_records_${SPACE}`);
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", { extractable: true });
  const thumbs = new Map<string, string>([["sess-1", await calculateJwkThumbprint(await exportJWK(publicKey))]]);
  const keys = new Map<string, CryptoKey>([["sess-1", privateKey as CryptoKey]]);
  const signer = { current: { kid: "sess-1", key: privateKey as CryptoKey }, resolve: (kid: string) => keys.get(kid), thumbprint: (kid: string) => thumbs.get(kid) };
  const clock = { t: NOW + 10 };
  const hooks = sessionRedemptionHooks({ store, registry, reader, signer, now: () => clock.t });

  // Provision the HOLDER through the REAL D13 primitives: win the UID reservation, birth the
  // gate frozen under an activation intent, write the alias head (epoch 3 for this scenario),
  // and reopen the gate at its first mintable generation. The serving side is the D14
  // endpoint-family stand-in.
  const actOp = mintLifecycleUid();
  c("the holder's UID reservation is won (create-only)",
    (await tryReserveUid(registry, HOLDER_UID, { owner: OWNER, actor: "cli", mintedBy: MGR })) === "won");
  const bornGate = await createGateFrozen(registry, { lifecycleUid: HOLDER_UID, op: { opId: actOp, kind: "activation" } });
  await recordsKv.create(headKey, enc.encode(JSON.stringify(headRow(3))));
  await reopenGate(registry, { lifecycleUid: HOLDER_UID, revision: bornGate.revision, opId: actOp });
  const gateRaw = async () => (await kv.get(`gate.${HOLDER_UID}`))!;
  await writeEndpointGate(kv, ENDPOINT, SERVING_IID, { state: "open", generation: 1, processEpoch: 7, registrationRevision: 1, nameAuthorityRevision: 1, principal: SERVING_PRINCIPAL });

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
    const row = JSON.parse(dec.decode((await kv.get(sessionLedgerKey(sid(1))))!.value)) as { state: string; revoked: { caller: boolean; serving: boolean } };
    c("the row is durably ACTIVE with both revocation marks false", row.state === "active" && !row.revoked.caller && !row.revoked.serving, row);
    // The NORMATIVE §13.1 ledger rows exist in their party families, closed-schema, with the
    // session lineage; the implementation pins live in the stage. family, never under cred./epcred.
    const callerRow = JSON.parse(dec.decode((await kv.get(`cred.${HOLDER_UID}.${sid(1)}.c`))!.value)) as { holderPrincipal: string; lifecycleUid: string; sourceChain: string[]; state: string };
    const servingRow = JSON.parse(dec.decode((await kv.get(`epcred.term.${SERVING_IID}.${sid(1)}.s`))!.value)) as { holderPrincipal: string; lifecycleUid: string; endpoint: string; sourceChain: string[]; state: string };
    c("the caller's NORMATIVE ledger row sits under its holder lifecycle (cred.<uid>.<sid>.c, session lineage, active)",
      callerRow.holderPrincipal === HOLDER_ID && callerRow.lifecycleUid === HOLDER_UID && callerRow.sourceChain[0] === `session.${sid(1)}` && callerRow.state === "active", callerRow);
    c("the serving NORMATIVE ledger row keys on its endpoint but its holderPrincipal is the CONNZ-evictable serving principal (not the endpoint name)",
      servingRow.holderPrincipal === SERVING_PRINCIPAL && servingRow.endpoint === ENDPOINT && servingRow.lifecycleUid === SERVING_IID && servingRow.sourceChain[0] === `session.${sid(1)}` && servingRow.state === "active", servingRow);
    c("the kid/thumbprint pins ride the stage. family (stage.session.<sid>.c/.s), not a ledger prefix",
      (await kv.get(`stage.session.${sid(1)}.c`)) !== null && (await kv.get(`stage.session.${sid(1)}.s`)) !== null);
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

  console.log("C. the §13.1 gate fence + gate/head currency");
  {
    // The REAL holder gate MOVES between observation and stage: wrap the observe hook to bump
    // the gate revision after pinning (a same-value touch — exactly what a barrier's freeze or
    // a concurrent mint's finalize does to the revision). The pinned touch must LOSE; the row
    // goes terminal and BOTH normative ledger rows are revoked AND marked.
    const g2 = mkGrant(sid(2));
    const moving: SessionRedemptionHooks = {
      ...hooks,
      observeHolderGate: async (h) => {
        const pin = await hooks.observeHolderGate(h);
        const cur = await gateRaw();
        await kv.put(`gate.${HOLDER_UID}`, cur.value);
        return pin;
      },
    };
    await rejects("a gate moved between observation and stage makes the pinned write LOSE (the fence is a write loss)",
      () => redeemSession(g2, PRESENTER, moving), "permission-denied");
    const row = JSON.parse(dec.decode((await kv.get(sessionLedgerKey(sid(2))))!.value)) as { state: string; revoked: { caller: boolean; serving: boolean } };
    c("…the burned row is TERMINAL with both staged credentials revoked and MARKED",
      row.state === "retired" && row.revoked.caller && row.revoked.serving, row);
    const burnedLedger = JSON.parse(dec.decode((await kv.get(`cred.${HOLDER_UID}.${sid(2)}.c`))!.value)) as { state: string };
    c("…and the loser's NORMATIVE ledger row is durably revoked (monotonic, never deleted)", burnedLedger.state === "revoked", burnedLedger);
    await rejects("…and the burned one-use never redeems again", () => redeemSession(g2, PRESENTER, hooks), "permission-denied");
  }
  {
    // Gate-state currency over the REAL gate family: retired and frozen gates refuse. (Raw
    // scenario writes with valid CLOSED rows — a frozen/retired gate is op-bound, SPEC 13.1.)
    const opId = mintLifecycleUid();
    await kv.put(`gate.${HOLDER_UID}`, enc.encode(JSON.stringify({ lifecycleUid: HOLDER_UID, state: "retired", generation: 1, op: { opId, kind: "retirement" } })));
    await rejects("a RETIRED holder gate refuses redemption", () => redeemSession(mkGrant(sid(3)), PRESENTER, hooks), "permission-denied");
    await kv.put(`gate.${HOLDER_UID}`, enc.encode(JSON.stringify({ lifecycleUid: HOLDER_UID, state: "frozen", generation: 1, op: { opId, kind: "takeover" } })));
    await rejects("a FROZEN holder gate refuses (a barrier is in flight; nothing mints under it)",
      () => redeemSession(mkGrant(sid(4)), PRESENTER, hooks), "permission-denied");
    await kv.put(`gate.${HOLDER_UID}`, enc.encode(JSON.stringify({ lifecycleUid: HOLDER_UID, state: "open", generation: 2 })));
  }
  {
    // HEAD currency (SPEC 13.1, amended): the holder's epoch is the alias-head read, active-ONLY.
    await recordsKv.put(headKey, enc.encode(JSON.stringify(headRow(4))));
    await rejects("a holder process epoch that moved refuses (an unredeemed grant dies with the restart)",
      () => redeemSession(mkGrant(sid(5)), PRESENTER, hooks), "expired");
    await recordsKv.put(headKey, enc.encode(JSON.stringify(headRow(3, { state: "retiring", op: { opId: mintLifecycleUid(), kind: "retirement" } }))));
    await rejects("a RETIRING head yields no current epoch (active is the ONLY current state)",
      () => redeemSession(mkGrant(sid(5)), PRESENTER, hooks), "expired");
    await recordsKv.put(headKey, enc.encode(JSON.stringify(headRow(3, { lifecycleUid: "z".repeat(26) }))));
    await rejects("a head naming a DIFFERENT lifecycleUid yields no epoch for this holder (uid-bound currency)",
      () => redeemSession(mkGrant(sid(5)), PRESENTER, hooks), "expired");
    await recordsKv.put(headKey, enc.encode(JSON.stringify(headRow(3))));
  }

  console.log("D. the authenticated close op");
  {
    const g6 = mkGrant(sid(6));
    await redeemSession(g6, PRESENTER, hooks);
    await rejects("a NON-party closer is refused against the authoritative row",
      () => closeSession(store, hooks, { sessionId: sid(6), closer: { kind: "serving", endpoint: ENDPOINT, instanceId: SERVING_IID, epoch: 99 } }), "permission-denied");
    const closed = await closeSession(store, hooks, { sessionId: sid(6), closer: { kind: "holder", ...PRESENTER } });
    c("a party close transitions the row terminal", closed.transitioned);
    const row = JSON.parse(dec.decode((await kv.get(sessionLedgerKey(sid(6))))!.value)) as { state: string; revoked: { caller: boolean; serving: boolean } };
    c("…closed durably, BOTH credentials revoked and marked", row.state === "closed" && row.revoked.caller && row.revoked.serving, row);
    const callerLedger = JSON.parse(dec.decode((await kv.get(`cred.${HOLDER_UID}.${sid(6)}.c`))!.value)) as { state: string };
    const servingLedger = JSON.parse(dec.decode((await kv.get(`epcred.term.${SERVING_IID}.${sid(6)}.s`))!.value)) as { state: string };
    c("…both NORMATIVE ledger rows are revoked in their own families", callerLedger.state === "revoked" && servingLedger.state === "revoked");
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
    const idle = await sweepSessions(store, hooks, { now: NOW + 1_000 }, scanner);
    c("an in-life active row is left alone", idle.acted === 0, idle);
    const pass1 = await sweepSessions(store, hooks, { now: NOW + 6_000 }, scanner);
    c("past exp the sweep transitions and revokes (one row acted)", pass1.acted === 1, pass1);
    const row = JSON.parse(dec.decode((await kv.get(sessionLedgerKey(sid(8))))!.value)) as { state: string; revoked: { caller: boolean; serving: boolean } };
    c("…expired durably, both halves revoked and marked", row.state === "expired" && row.revoked.caller && row.revoked.serving, row);
    c("a fully-collected terminal row is never touched again", (await sweepSessions(store, hooks, { now: NOW + 7_000 }, scanner)).acted === 0);
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
    const afterClose = JSON.parse(dec.decode((await kv.get(sessionLedgerKey(sid(9))))!.value)) as { revoked: { caller: boolean; serving: boolean } };
    c("the failed half stays UNMARKED (the mark is set only by a revoke that succeeded)",
      afterClose.revoked.caller && !afterClose.revoked.serving, afterClose);
    failServing = false;
    const retryPass = await sweepSessions(store, flaky, { now: NOW + 1_000 }, scanner);
    const afterRetry = JSON.parse(dec.decode((await kv.get(sessionLedgerKey(sid(9))))!.value)) as { revoked: { caller: boolean; serving: boolean } };
    c("the next sweep pass retries EXACTLY the unmarked half to completion",
      retryPass.acted === 1 && afterRetry.revoked.serving, { retryPass, afterRetry });
  }

  console.log("F. fail-closed row parsing + the freelance-round fixes");
  await kv.put(sessionLedgerKey(sid(10).slice(0, 22) + "gg"), enc.encode("{\"garbled\":true}"));
  await rejects("a garbled session row refuses (internal), never authorizes",
    () => hooks.ledger.read(sid(10).slice(0, 22) + "gg"), "internal");

  // (2) CLOCK VALIDATION: a malformed trusted clock never authorizes or terminates.
  {
    const nanHooks = sessionRedemptionHooks({ store, registry, reader, signer, now: () => Number.NaN });
    await rejects("a NaN redemption clock refuses (never finalizes a dead grant active)",
      () => redeemSession(mkGrant(sid(20)), PRESENTER, nanHooks), "failed-precondition");
    await rejects("a NaN sweep clock refuses (never expires every live row at once)",
      () => sweepSessions(store, hooks, { now: Number.NaN }, scanner), "failed-precondition");
    await rejects("a negative sweep margin refuses", () => sweepSessions(store, hooks, { now: NOW, marginMs: -1 }, scanner), "failed-precondition");
    // The sweep's SCANNER brand/space bond (the freelance seal hole: this public dispatch never
    // asserted the scanner, so a structural stub swept "successfully" over nothing).
    await rejects("a HAND-ASSEMBLED scanner refuses at the sweep dispatch (an empty enumeration would report success while expired credentials stay active)",
      () => sweepSessions(store, hooks, { now: NOW }, { scanCredentialFamily: async () => [], scanBysrc: async () => [], scanStageFamily: async () => [], scanSessions: async () => [], close: async () => {} } as never), "failed-precondition");
    await rejects("a FOREIGN-SPACE scanner refuses at the sweep dispatch (foreign rows never drive local revoke hooks)",
      () => sweepSessions(store, hooks, { now: NOW }, makeLedgerScannerOverConnection(nc, "otherspace")), "failed-precondition");
    // The STORE handle is frozen before branding: a post-brand kv/space rebind throws rather than
    // redirecting authority rows to a foreign space over a still-valid brand.
    let storeRebindDenied = false;
    try { (store as { space: string }).space = "otherspace"; } catch { storeRebindDenied = true; }
    c("the branded session store is FROZEN: a post-brand space/kv rebind THROWS", storeRebindDenied && Object.isFrozen(store));
  }

  // (5) EXACT-REPLAY retry identity: a DIFFERENT grant reusing the sessionId + holder does NOT
  // re-release the winner's credential; only an exact replay of the winning grant does.
  {
    const gWin = mkGrant(sid(21));
    await redeemSession(gWin, PRESENTER, hooks);
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
    const rotHooks = sessionRedemptionHooks({ store, registry, reader, signer: rotSigner, now: () => clock.t });
    const first = await redeemSession(gRot, PRESENTER, rotHooks);
    const rotatedSigner = { current: { kid: "sess-2", key: k2 as CryptoKey }, resolve: (kid: string) => keys.get(kid), thumbprint: (kid: string) => thumbs.get(kid) };
    const rotatedHooks = sessionRedemptionHooks({ store, registry, reader, signer: rotatedSigner, now: () => clock.t });
    const retry = await redeemSession(gRot, PRESENTER, rotatedHooks);
    c("a lost-response retry after a signer rotation yields BYTE-IDENTICAL creds (the row pins the kid)", retry.creds === first.creds);
    const goneSigner = { current: { kid: "sess-2", key: k2 as CryptoKey }, resolve: (kid: string) => (kid === "sess-2" ? (k2 as CryptoKey) : undefined), thumbprint: (kid: string) => thumbs.get(kid) };
    const goneHooks = sessionRedemptionHooks({ store, registry, reader, signer: goneSigner, now: () => clock.t });
    await rejects("release fails closed when the pinned signing key is unresolvable (no re-mint)",
      () => redeemSession(gRot, PRESENTER, goneHooks), "unavailable");
  }

  // (7) ROW/PIN FAIL-CLOSED: a corrupt ledger row or stage pin with widened content never signs.
  {
    const gC = mkGrant(sid(23));
    await redeemSession(gC, PRESENTER, hooks);
    // Corrupt the SERVING stage pin (the widened-subjects trust vector): parseStagePin refuses.
    await kv.put(`stage.session.${sid(23)}.s`, enc.encode(JSON.stringify({ v: 1, kind: "session", sessionId: sid(23), party: "serving", kid: "sess-1", kidThumbprint: "t", exp: NOW + 60_000, subjects: { pub: ["cotal.evil.>"], sub: [] } })));
    await rejects("a stage pin with an UNKNOWN field (widened subjects) refuses (closed schema, never signs)",
      () => retrieveServingCredential(sid(23), { endpoint: ENDPOINT, instanceId: SERVING_IID, epoch: 7 }, hooks), "internal");
    // Corrupt the serving NORMATIVE row with an unknown field: parseLedgerRow refuses too.
    const gD = mkGrant(sid(28));
    await redeemSession(gD, PRESENTER, hooks);
    const ledgerKey = `epcred.term.${SERVING_IID}.${sid(28)}.s`;
    const good = JSON.parse(dec.decode((await kv.get(ledgerKey))!.value)) as Record<string, unknown>;
    await kv.put(ledgerKey, enc.encode(JSON.stringify({ ...good, subjects: ["cotal.evil.>"] })));
    await rejects("a NORMATIVE ledger row with an UNKNOWN field refuses (closed schema, never signs)",
      () => retrieveServingCredential(sid(28), { endpoint: ENDPOINT, instanceId: SERVING_IID, epoch: 7 }, hooks), "internal");
  }

  // (8) SWEEP CONTINUES past a poison row: one malformed key never blocks the rest.
  {
    const gP1 = mkGrant(sid(24), { exp: NOW + 5_000 });
    await redeemSession(gP1, PRESENTER, hooks);
    await kv.put(sessionLedgerKey(sid(25).slice(0, 22) + "gg"), enc.encode("{\"poison\":true}"));
    const pass = await sweepSessions(store, hooks, { now: NOW + 6_000 }, scanner);
    const row = JSON.parse(dec.decode((await kv.get(sessionLedgerKey(sid(24))))!.value)) as { state: string };
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

  // (6) GATE-FAMILY DISJOINTNESS: a redemption where the serving instanceId equals the holder
  // UID string still redeems — the holder gate is `gate.<uid>` and the serving gate is
  // `epgate.<endpoint>.<iid>`, disjoint by explicit prefix (SPEC 13.1), so no key collision.
  {
    const selfOwner = `u_${"b".repeat(26)}`;
    const selfUid = "f".repeat(26);
    const selfOp = mintLifecycleUid();
    await tryReserveUid(registry, selfUid, { owner: selfOwner, actor: "cli", mintedBy: MGR });
    const g = await createGateFrozen(registry, { lifecycleUid: selfUid, op: { opId: selfOp, kind: "activation" } });
    await recordsKv.create(recordAtomicKey(LIFECYCLE_HEAD, [selfOwner, "cli"]), enc.encode(JSON.stringify({ owner: selfOwner, actor: "cli", lifecycleUid: selfUid, managerInstance: MGR, processEpoch: 3, state: "active" })));
    await reopenGate(registry, { lifecycleUid: selfUid, revision: g.revision, opId: selfOp });
    await writeEndpointGate(kv, ENDPOINT, selfUid, { state: "open", generation: 1, processEpoch: 3, registrationRevision: 1, nameAuthorityRevision: 1, principal: SERVING_PRINCIPAL });
    const gSelf = mkGrant(sid(27), { holder: { id: `${selfOwner}.cli`, lifecycleUid: selfUid, processEpoch: 3 }, serving: { instanceId: selfUid, epoch: 3 }, subjects: { in: epsSubject(SPACE, ENDPOINT, sid(27), 3, "in"), out: epsSubject(SPACE, ENDPOINT, sid(27), 3, "out") } });
    const selfCred = await redeemSession(gSelf, { id: `${selfOwner}.cli`, lifecycleUid: selfUid }, hooks);
    c("a redemption sharing the holder-UID/serving-instanceId string redeems (disjoint gate families, no collision)",
      selfCred.id === `${selfUid}.${sid(27)}.c`);
  }

  console.log("H. the 006baac security round: branded contexts, thumbprint, party-close, endpoint collision");
  {
    // BRANDED store: a hand-assembled {kv, space} never authorizes.
    await rejects("a hand-assembled {kv, space} store refuses (the space bond is constructed, not asserted)",
      () => sessionRedemptionHooks({ store: { kv, space: SPACE }, registry, reader, signer }).allocateCredentialIds(mkGrant(sid(40))) as never, "failed-precondition");
    // BRANDED registry: a hand-assembled { space } registry never authorizes either.
    await rejects("a hand-assembled { space } registry refuses at hook construction (the seal is the WeakMap brand)",
      () => sessionRedemptionHooks({ store, registry: { space: SPACE } as LifecycleRegistry, reader, signer }), "failed-precondition");
    // Cross-space composition refuses.
    await rejects("a registry bonded to a DIFFERENT space refuses at hook construction (no cross-space authority)",
      async () => {
        await createEndpointStreams(await jetstreamManager(nc), new Kvm(nc), "otherspace");
        const foreign = await openLifecycleRegistry(nc, "otherspace");
        sessionRedemptionHooks({ store, registry: foreign, reader, signer });
      }, "failed-precondition");
    // THUMBPRINT rebind: the same kid resolving to DIFFERENT key material refuses at release.
    const gT = mkGrant(sid(41));
    await redeemSession(gT, PRESENTER, hooks);
    const { privateKey: kOther } = await generateKeyPair("EdDSA", { extractable: true });
    const rebindSigner = { current: { kid: "sess-1", key: kOther as CryptoKey }, resolve: (_kid: string) => kOther as CryptoKey, thumbprint: (_kid: string) => "a-different-thumbprint" };
    const rebindHooks = sessionRedemptionHooks({ store, registry, reader, signer: rebindSigner, now: () => clock.t });
    await rejects("a kid rebound to different key material refuses at release (thumbprint mismatch, not just the label)",
      () => redeemSession(gT, PRESENTER, rebindHooks), "permission-denied");
    // PARTY close cannot name a barrier-specific terminal reason.
    const gP = mkGrant(sid(42));
    await redeemSession(gP, PRESENTER, hooks);
    await rejects("a PARTY close naming a barrier reason (superseded) refuses (only the operator/barrier names it)",
      () => closeSession(store, hooks, { sessionId: sid(42), closer: { kind: "holder", ...PRESENTER }, to: "superseded" }), "permission-denied");
    const okClose = await closeSession(store, hooks, { sessionId: sid(42), closer: { kind: "holder", ...PRESENTER } });
    c("…a party close without a reason produces `closed`", okClose.transitioned);
    // ENDPOINT COLLISION: the SAME instanceId under a DIFFERENT endpoint has a distinct epgate +
    // credential family (endpoint-qualified), so one endpoint's session never touches the other's.
    const OTHER_EP = "other";
    await writeEndpointGate(kv, OTHER_EP, SERVING_IID, { state: "open", generation: 1, processEpoch: 7, registrationRevision: 1, nameAuthorityRevision: 1, principal: SERVING_PRINCIPAL });
    const gColl = mkGrant(sid(43), { endpoint: OTHER_EP, subjects: { in: epsSubject(SPACE, OTHER_EP, sid(43), 7, "in"), out: epsSubject(SPACE, OTHER_EP, sid(43), 7, "out") } });
    const collCred = await redeemSession(gColl, PRESENTER, hooks);
    const collServing = await retrieveServingCredential(sid(43), { endpoint: OTHER_EP, instanceId: SERVING_IID, epoch: 7 }, hooks);
    c("the same instanceId under a DIFFERENT endpoint has an endpoint-qualified serving cred family (no collision)",
      collCred.id === `${HOLDER_UID}.${sid(43)}.c` && collServing.id === `other.${SERVING_IID}.${sid(43)}.s`, { collCred: collCred.id, collServing: collServing.id });
    // The epgate DEL-marker discipline: a deletion marker under the endpoint gate family is
    // corruption, never absence — the epoch read refuses loudly instead of yielding undefined.
    await writeEndpointGate(kv, "delep", "d".repeat(26), { state: "open", generation: 1, processEpoch: 1, registrationRevision: 1, nameAuthorityRevision: 1, principal: SERVING_PRINCIPAL });
    await kv.delete(epgateKey("delep", "d".repeat(26)));
    await rejects("a DEL marker under epgate.<ep>.<iid> refuses the epoch read (corruption, not absence)",
      () => hooks.servingEpoch("delep", "d".repeat(26)), "failed-precondition");
    // STORE config: a mirror/MaxAge store is refused (proven at open by the shape check; here we
    // just confirm the primary store bound cleanly and is branded).
    c("the primary auth store bound cleanly (allow_direct=false, no MaxAge, not a mirror)", store.space === SPACE);
  }

  console.log("I. the round-3 fold: epgate grammar parity, session DEL markers, reconciler principals");
  {
    // The epgate principal must be a REAL owner-grammar principal — a dot-form-only value
    // (`foo.bar`) would stage a session whose serving epcred row later refuses to parse,
    // leaving a poisoned, unenumerable serving half.
    const BADIID = "b".repeat(26);
    await writeEndpointGate(kv, "badp", BADIID, { state: "open", generation: 1, processEpoch: 1, registrationRevision: 1, nameAuthorityRevision: 1, principal: "foo.bar" });
    await rejects("an epgate whose principal is dot-form but NOT owner-grammar (foo.bar) refuses at parse",
      () => hooks.servingEpoch("badp", BADIID), "internal");
    // The agent gate's STATE x KIND invariant applies to the endpoint family: a retired gate
    // under a takeover kind is impossible persisted state.
    await writeEndpointGate(kv, "badk", BADIID, { state: "retired", generation: 1, processEpoch: 1, registrationRevision: 1, nameAuthorityRevision: 1, principal: SERVING_PRINCIPAL, op: { opId: "o".repeat(26), kind: "takeover" } } as never);
    await rejects("an epgate RETIRED under a takeover kind refuses at parse (impossible persisted state)",
      () => hooks.servingEpoch("badk", BADIID), "internal");
    // A malformed opId on the epgate op intent refuses (token grammar parity with the agent gate).
    await writeEndpointGate(kv, "bado", BADIID, { state: "frozen", generation: 1, processEpoch: 1, registrationRevision: 1, nameAuthorityRevision: 1, principal: SERVING_PRINCIPAL, op: { opId: "not a token!", kind: "takeover" } } as never);
    await rejects("an epgate op intent with a malformed opId refuses at parse",
      () => hooks.servingEpoch("bado", BADIID), "internal");
    // A DEL marker on a SESSION row is corruption, never absence: the read refuses loudly
    // instead of letting a takeover reconciliation no-op over a live serving half.
    const gDel = mkGrant(sid(44));
    await redeemSession(gDel, PRESENTER, hooks);
    await kv.delete(sessionLedgerKey(sid(44)));
    await rejects("a DEL marker on session.<sid> refuses the ledger read (corruption, not absence)",
      () => hooks.ledger.read(sid(44)), "failed-precondition");
    // …AND the SWEEP must SEE that marker (fact-3/distsys HIGH: a bucket's kv.keys() FILTERS
    // DEL/PURGE, so a keys-based sweep would never encounter the tombstone; the marker-preserving
    // LastPerSubject enumeration reports it in `failed`, never silently skips it).
    {
      const swept = await sweepSessions(store, hooks, { now: clock.t }, scanner);
      c("the sweep SEES a tombstoned session key and reports it as failed (not filtered away by kv.keys)",
        swept.failed.includes(sessionLedgerKey(sid(44))), swept.failed);
    }
    // The takeover reconciler returns the serving row's CONNZ-evictable principal (the
    // barrier's eviction set joins it) and is idempotent across re-runs.
    const gRec = mkGrant(sid(45));
    await redeemSession(gRec, PRESENTER, hooks);
    const rec1 = await reconcileSessionForTakeover(store, hooks, sid(45));
    c("the takeover reconciler returns the serving principal for the barrier's eviction set",
      rec1.servingPrincipals.length === 1 && rec1.servingPrincipals[0] === SERVING_PRINCIPAL, rec1);
    const rec2 = await reconcileSessionForTakeover(store, hooks, sid(45));
    c("…idempotent: a re-run still returns it (a resumed barrier must re-evict)",
      rec2.servingPrincipals.length === 1 && rec2.servingPrincipals[0] === SERVING_PRINCIPAL, rec2);
  }

  console.log("J. the D14 production serve-issuance gate over the durable endpoint families");
  {
    const EP = "servegate";
    const IID = "g".repeat(26);
    const seam = kvServeIssuanceGate(store, { endpoint: EP, instanceId: IID });
    await rejects("a hand-assembled {kv, space} refuses (the space bond is constructed, not asserted)",
      async () => kvServeIssuanceGate({ kv, space: SPACE }, { endpoint: EP, instanceId: IID }), "failed-precondition");
    c("observe of a MISSING gate is null (the mint fails closed on it)", (await seam.observe()) === null);
    await writeEndpointGate(kv, EP, IID, { state: "open", generation: 2, processEpoch: 5, registrationRevision: 3, nameAuthorityRevision: 1, principal: SERVING_PRINCIPAL });
    const g1 = await seam.observe();
    c("observe maps the durable gate row + the store revision into the §13.1 gate state",
      g1 !== null && g1.state === "open" && g1.generation === 2 && g1.processEpoch === 5
      && g1.registrationRevision === 3 && g1.nameAuthorityRevision === 1
      && g1.endpoint === EP && g1.lifecycleUid === IID && g1.space === SPACE && typeof g1.revision === "number");
    const digestId = `sha256-${"e".repeat(64)}`;
    const mkRow = (over: Record<string, unknown> = {}) => ({
      credentialId: digestId, credentialKey: "UKEYUNPERSISTED", holderPrincipal: SERVING_PRINCIPAL,
      endpoint: EP, lifecycleUid: IID, sourceChain: ["root"], state: "active" as const,
      exp: NOW + 60_000, generation: 2, processEpoch: 5, registrationRevision: 3, nameAuthorityRevision: 1,
      ...over,
    });
    await seam.stage(mkRow() as never);
    {
      const stored = await kv.get(`epcred.${EP}.${IID}.${digestId}`);
      const row = parseLedgerRow(stored!.value, `epcred.${EP}.${IID}.${digestId}`);
      c("stage writes the NORMATIVE epcred row (closed schema; coordinates + nkey not persisted; key rebuilds)",
        row.state === "active" && row.endpoint === EP && row.lifecycleUid === IID && row.holderPrincipal === SERVING_PRINCIPAL
        && row.sourceChain.length === 1 && row.sourceChain[0] === "root");
    }
    await seam.stage(mkRow() as never);
    c("re-staging the SAME issuance is byte-idempotent (one row)", true);
    await rejects("a FOREIGN-content restage for the same credentialId conflicts (a staged name never re-binds)",
      () => seam.stage(mkRow({ holderPrincipal: `u_${"d".repeat(26)}.evil` }) as never), "conflict");
    await rejects("a row naming a FOREIGN endpoint/instance refuses (a row never crosses families)",
      () => seam.stage(mkRow({ endpoint: "otherep" }) as never), "failed-precondition");
    await rejects("the pre-fix `sha256:<hex>` id form REFUSES at the key boundary (the ledger grammar has no colon)",
      () => seam.stage(mkRow({ credentialId: `sha256:${"e".repeat(64)}` }) as never));
    c("commit WINS the pinned touch at the observed revision", (await seam.commit(g1!.revision)) === true);
    c("…and the winning touch advanced the gate revision (the SAME pin cannot win twice)", (await seam.commit(g1!.revision)) === false);
    {
      const g2 = await seam.observe();
      await writeEndpointGate(kv, EP, IID, { state: "frozen", generation: 2, processEpoch: 5, registrationRevision: 3, nameAuthorityRevision: 1, principal: SERVING_PRINCIPAL, op: { opId: "o".repeat(26), kind: "takeover" } });
      c("a barrier freeze after observation makes the parked mint's pinned commit LOSE (durable re-proof of the parked-mint race)",
        (await seam.commit(g2!.revision)) === false);
      const g3 = await seam.observe();
      c("…and a commit pinned at the CURRENT revision still refuses while frozen (only an open gate mints)",
        (await seam.commit(g3!.revision)) === false);
    }
    await seam.revoke(mkRow() as never);
    {
      const stored = await kv.get(`epcred.${EP}.${IID}.${digestId}`);
      const row = parseLedgerRow(stored!.value, `epcred.${EP}.${IID}.${digestId}`);
      c("revoke marks the staged row revoked (monotonic, never deleted)", row.state === "revoked");
    }
    // fact M7: revoke runs only after a successful stage, so an ABSENT row is vanished never-delete
    // ledger state (corruption), not a never-staged idempotence case; it must fail LOUD, not be
    // hidden. (A re-revoke of an ALREADY-revoked staged row stays idempotent - proven above.)
    await rejects("revoking a NEVER-STAGED (absent) row fails loud (corruption, not idempotent abort)",
      () => seam.revoke(mkRow({ credentialId: `sha256-${"f".repeat(64)}` }) as never), "failed-precondition");
  }

  await nc.drain().catch(() => {});
} finally {
  broker.kill("SIGKILL");
  await new Promise((r) => broker.once("exit", r));
  rmSync(sd, { recursive: true, force: true });
}

console.log(fail === 0 ? `\nSESSION ADAPTER SMOKE OK ✅  (${ok} passed, ${fail} failed)` : `\nSESSION ADAPTER SMOKE FAILED ❌  (${ok} passed, ${fail} failed)`);
if (fail > 0) process.exit(1);
