/**
 * v0.4 §13.6 SESSION (bidirectional stream) smoke — the composite's three layers:
 *
 *   A. the SESSION GRANT artifact (broker-free): mint → verify round-trip; the refusal
 *      battery — wrong audience, substituted/tampered rail subjects, unknown field (top-level
 *      AND nested: every object is a closed schema), unknown/revoked/wrong-role/scope-closed
 *      key, tampered payload, expired, not-yet-valid, TTL over the live ceiling, window out of
 *      bounds, free-form holder id (principal grammar), short sessionId (unguessability
 *      floor), and the UTF-8 BYTE bound (multibyte cannot slide under on char count).
 *   B. the LEDGER + REDEMPTION seam (faithful in-memory ledger with REAL revision-pinned
 *      gates): presenter authentication (a leaked grant is not a bearer artifact), one-use
 *      with the authenticated-holder retry exception (lost response → same credential, never
 *      a re-mint), the ADVERSARIAL two-gate fence probe (a gate moved between observation and
 *      stage makes the pinned write LOSE), finalize fresh-checks (holder/serving epoch drift
 *      AND expiry-at-finalize), redemption-racing-close, serving retrieval bound to the FULL
 *      authenticated serving identity against the AUTHORITATIVE row (wrong instance/epoch/
 *      endpoint refuse), hostile release hooks fail loud (wrong id, credential outliving the
 *      session, aliased ids), release-outage recovery (row stays active; retry recovers), the
 *      sweep's REAL revoke retry (per-credential marks; a failed revoke is retried on the
 *      terminal row until confirmed), state-grammar monotonicity.
 *   C. the RAILS over a REAL broker: duplex in-order delivery with credits cycling through a
 *      small window; window overflow REFUSES resource-exhausted (no buffering); a sequence
 *      GAP breaks the session loudly; duplicates drop; garbled frames and credit overruns
 *      surface as protocol errors; an OVERRUNNING PIGGYBACK breaks the rail BEFORE its data
 *      reaches the app; a THROWING HANDLER earns no delivery and no credit; the
 *      DOUBLE-CREDIT-LOSS counterexample (an already-emitted watermark is re-advertised while
 *      the peer is quiet); the TIMER-driven stall watchdog (fires with no further send call);
 *      peer-close teardown (no remotely triggerable subscription/timer leak); the in-band
 *      close is advisory.
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
import { pickFreePort } from "./_free-port.js";

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
/** The AUTHENTICATED presenter the trusted auth path establishes (here: the honest holder). */
const PRESENTER = { id: HOLDER.id, lifecycleUid: HOLDER.lifecycleUid };
/** The authenticated serving identity for per-party retrieval. */
const SERVING_PRESENTER = { endpoint: ENDPOINT, instanceId: SERVING.instanceId, epoch: SERVING.epoch };
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
await rejects("unknown field INSIDE holder refuses (closed nested schema)", async () => {
  const g = mint();
  const { sig: _s, ...unsigned } = g;
  await verify(signArtifact({ ...unsigned, holder: { ...g.holder, admin: true } }, kp));
}, "contract-invalid");
await rejects("unknown field INSIDE issuer refuses (closed nested schema)", async () => {
  const g = mint();
  const { sig: _s, ...unsigned } = g;
  await verify(signArtifact({ ...unsigned, issuer: { keyId: "k1", scope: "all" } }, kp));
}, "contract-invalid");
await rejects("a free-form holder id refuses at mint (principal grammar, not any string)", () => mint({ holder: { ...HOLDER, id: "not a principal!" } }), "contract-invalid");
await rejects("a short caller-supplied sessionId refuses at mint (unguessability floor)", () => mint({ sessionId: "shortid1" }), "contract-invalid");
await rejects("a short sessionId refuses at verify even re-signed", async () => {
  const g = mint();
  const { sig: _s, ...unsigned } = g;
  await verify(signArtifact({ ...unsigned, sessionId: "shortid1" }, kp));
}, "contract-invalid");
await rejects("the grant byte bound counts UTF-8 BYTES, not JS chars", async () => verify({ ...mint(), space: "€".repeat(6000) }), "contract-invalid");
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
// The clock-anchored ceiling parity (handle rules, SPEC 1778/13.10): a FORWARD-DATED grant must
// not manufacture validity past the live ceiling even when its own span is in-bounds. A span-only
// implementation accepts this artifact (exp-iat = the ceiling exactly); a clock-anchored one refuses.
await rejects("a FORWARD-DATED iat (span in-bounds, valid far past now+ceiling) refuses (clock-anchored, not just span)", async () => {
  const g = mint();
  const { sig: _s, ...unsigned } = g;
  // iat=now+24h, exp=iat+24h: span = 24h passes the span check, but the artifact claims validity
  // out to now+48h; the clock-anchored currency gates (future iat / exp past now+ceiling) refuse.
  await verify(signArtifact({ ...unsigned, iat: NOW + SESSION_GRANT_MAX_TTL_MS, exp: NOW + 2 * SESSION_GRANT_MAX_TTL_MS }, kp), NOW);
}, "permission-denied");
await rejects("a future iat (signed ahead of now) refuses", async () => {
  const g = mint();
  const { sig: _s, ...unsigned } = g;
  await verify(signArtifact({ ...unsigned, iat: NOW + 5000, exp: NOW + 5000 + 60_000 }, kp), NOW + 10);
}, "permission-denied");
await rejects("an empty/backward window (exp <= iat) refuses at verify", async () => {
  const g = mint();
  const { sig: _s, ...unsigned } = g;
  await verify(signArtifact({ ...unsigned, iat: NOW, exp: NOW }, kp), NOW + 10);
}, "contract-invalid");
await rejects("nbf past exp refuses at verify", async () => {
  const g = mint();
  const { sig: _s, ...unsigned } = g;
  await verify(signArtifact({ ...unsigned, iat: NOW, nbf: NOW + 90_000, exp: NOW + 60_000 }, kp), NOW + 10);
}, "contract-invalid");
await rejects("an early nbf stretching the span past the ceiling refuses", async () => {
  const g = mint();
  const { sig: _s, ...unsigned } = g;
  // iat within ceiling of exp, but nbf far earlier makes min(iat,nbf) blow the span ceiling.
  await verify(signArtifact({ ...unsigned, nbf: NOW - SESSION_GRANT_MAX_TTL_MS, iat: NOW + 10, exp: NOW + 60_000 }, kp), NOW + 20);
}, "contract-invalid");
// The CLOCK AUTHORITY itself fails closed (handle-entry parity): every currency rule is a
// numeric comparison, so an invalid `now` would make them ALL silently false and a stale or
// forward-dated grant would VERIFY.
await rejects("a NaN clock refuses at entry (an invalid clock authority never verifies)", async () => verify(mint(), Number.NaN), "failed-precondition");
await rejects("a negative clock refuses at entry", async () => verify(mint(), -1), "failed-precondition");
await rejects("a fractional clock refuses at entry", async () => verify(mint(), NOW + 0.5), "failed-precondition");

// ---------- B. ledger + redemption seam ----------
console.log("B. presenter-authenticated one-use redemption + the pinned two-gate fence");

interface FakeState { rows: Map<string, SessionLedgerRow>; revoked: string[]; staged: number; released: string[]; alloc: number; gates: Map<string, number> }
function fakeHooks(over: Partial<SessionRedemptionHooks> = {}): { hooks: SessionRedemptionHooks; st: FakeState } {
  const st: FakeState = { rows: new Map(), revoked: [], staged: 0, released: [], alloc: 0, gates: new Map() };
  const ledger: SessionLedger = {
    // The AUTHORITATIVE read hands back a copy, like a real KV get — callers must not be able
    // to mutate ledger truth through the projection.
    read: (id) => { const r = st.rows.get(id); return r ? { ...r, serving: { ...r.serving }, holder: { ...r.holder }, revoked: { ...r.revoked } } : undefined; },
    createIssuing(row) {
      if (st.rows.has(row.sessionId)) return "exists";
      st.rows.set(row.sessionId, { ...row, revoked: { ...row.revoked } });
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
    markRevoked(id, credId) {
      const r = st.rows.get(id);
      if (!r) throw new Error(`markRevoked: no row ${id}`);
      if (credId === r.credCaller) r.revoked.caller = true;
      else if (credId === r.credServing) r.revoked.serving = true;
      else throw new Error(`markRevoked: unknown credential ${credId}`);
    },
  };
  const gatePin = (key: string) => { if (!st.gates.has(key)) st.gates.set(key, 1); return { key, revision: st.gates.get(key)! }; };
  const hooks: SessionRedemptionHooks = {
    ledger,
    holderProcessEpoch: () => HOLDER.processEpoch,
    servingEpoch: () => SERVING.epoch,
    allocateCredentialIds: () => {
      const n = ++st.alloc;
      return { credCaller: `cc${n}`, credServing: `cs${n}` };
    },
    observeHolderGate: (h) => gatePin(`gate.${h.lifecycleUid}`),
    observeServingGate: (_e, inst) => gatePin(`gate.${inst}`),
    // The lifecycle FENCE is REAL in this fake: each stage is revision-pinned to its observed
    // gate; a gate that moved since observation makes the stage LOSE (a write loss, not a read).
    stagePair: (_g, _ids, pins) => {
      for (const pin of [pins.holder, pins.serving]) {
        const cur = st.gates.get(pin.key);
        if (cur !== pin.revision) throw new EpEnvelopeError("permission-denied", `gate ${pin.key} moved (rev ${cur}, pinned ${pin.revision}); the pinned stage loses`);
      }
      st.staged++;
    },
    // Idempotent for the row's life: same bytes on repeat (the lost-response retry path).
    releaseCredential: (_sid, credId) => { st.released.push(credId); return { id: credId, creds: `CREDS-${credId}`, exp: NOW + 30_000 }; },
    revokeCredential: (id) => { st.revoked.push(id); },
    now: () => NOW + 10,
    ...over,
  };
  return { hooks, st };
}

{
  const g = await verify(mint());
  const { hooks, st } = fakeHooks();
  const holderCred = await redeemSession(g, PRESENTER, hooks);
  const row = st.rows.get(g.sessionId)!;
  c("happy path: row active, ENDPOINT + both ids recorded from creation, ONLY the holder credential released",
    row.state === "active" && row.endpoint === ENDPOINT && row.credCaller === "cc1" && row.credServing === "cs1" && holderCred.id === "cc1" && holderCred.exp <= g.exp && st.released.join() === "cc1" && st.revoked.length === 0, { row, holderCred, released: st.released });
  c("ledger key grammar", sessionLedgerKey(g.sessionId) === `session.${g.sessionId}`);
  // The ONE authenticated exception to the one-use: the holder whose response was lost retries
  // and gets the SAME credential back — no re-mint, no new stage, no second session.
  const again = await redeemSession(g, PRESENTER, hooks);
  c("the authenticated holder's retry re-releases the SAME credential (lost response recovers; nothing re-staged)",
    again.id === "cc1" && st.staged === 1 && st.rows.get(g.sessionId)!.credCaller === "cc1", { again, staged: st.staged });
}
{
  // PRESENTER AUTHENTICATION: possession of the signed grant is NOT authority.
  const g = await verify(mint());
  const { hooks, st } = fakeHooks();
  await rejects("a leaked grant redeemed by a NON-holder presenter refuses (holder-bound, never bearer)",
    () => redeemSession(g, { id: "u_thief.cli", lifecycleUid: HOLDER.lifecycleUid }, hooks), "permission-denied");
  await rejects("the holder's principal under ANOTHER lifecycle refuses (live authority, 13.1)",
    () => redeemSession(g, { id: HOLDER.id, lifecycleUid: "x".repeat(26) }, hooks), "permission-denied");
  c("…identity is checked FIRST: nothing allocated, the one-use is NOT burned", st.alloc === 0 && st.rows.size === 0, st);
}
{
  // A duplicate against a row still MID-ISSUE refuses: the retry exception applies only to active.
  const g = await verify(mint());
  const { hooks, st } = fakeHooks();
  st.rows.set(g.sessionId, { sessionId: g.sessionId, endpoint: ENDPOINT, serving: SERVING, holder: { principal: HOLDER.id, lifecycleUid: HOLDER.lifecycleUid }, credCaller: "ccI", credServing: "csI", revoked: { caller: false, serving: false }, state: "issuing", exp: NOW + 60_000 });
  await rejects("a duplicate against a still-issuing row refuses (one-use; the retry applies only to an active row)", () => redeemSession(g, PRESENTER, hooks), "permission-denied");
  c("…and released nothing", st.released.length === 0);
}
{
  // SERVING RETRIEVAL: the FULL authenticated serving identity against the AUTHORITATIVE row.
  const g = await verify(mint());
  const { hooks } = fakeHooks();
  await redeemSession(g, PRESENTER, hooks);
  const sc = await retrieveServingCredential(g.sessionId, SERVING_PRESENTER, hooks);
  c("the serving side retrieves ITS OWN credential via its authenticated identity (no cross-party bytes)", sc.id === "cs1" && sc.exp <= g.exp, sc);
  c("…idempotently (a lost response retries to the same bytes)", (await retrieveServingCredential(g.sessionId, SERVING_PRESENTER, hooks)).id === "cs1");
  await rejects("a WRONG instanceId refuses (per-party release)", () => retrieveServingCredential(g.sessionId, { ...SERVING_PRESENTER, instanceId: "z".repeat(26) }, hooks), "permission-denied");
  await rejects("a WRONG epoch refuses", () => retrieveServingCredential(g.sessionId, { ...SERVING_PRESENTER, epoch: SERVING.epoch + 1 }, hooks), "permission-denied");
  await rejects("the SAME instanceId under a DIFFERENT endpoint refuses (instanceId is unique only per endpoint; the row pins it)",
    () => retrieveServingCredential(g.sessionId, { ...SERVING_PRESENTER, endpoint: "other" }, hooks), "permission-denied");
  await rejects("an unknown session refuses (the row is read authoritatively, never caller-supplied)",
    () => retrieveServingCredential(mintSessionId(), SERVING_PRESENTER, hooks), "not-found");
}
{
  // retrieveServingCredential refuses on a non-active row (an issuing row confers nothing).
  const { hooks, st } = fakeHooks();
  const sid = mintSessionId();
  st.rows.set(sid, { sessionId: sid, endpoint: ENDPOINT, serving: SERVING, holder: { principal: HOLDER.id, lifecycleUid: HOLDER.lifecycleUid }, credCaller: "ccX", credServing: "csX", revoked: { caller: false, serving: false }, state: "issuing", exp: NOW + 60_000 });
  await rejects("serving retrieval on a non-active row refuses (issuing confers nothing)",
    () => retrieveServingCredential(sid, SERVING_PRESENTER, hooks), "failed-precondition");
}
{
  // The LIFECYCLE FENCE, direct form: the gate-pinned stage LOSES (throws). The row is
  // transitioned terminal, both ids revoked AND marked; nothing released.
  const g = await verify(mint());
  const { hooks, st } = fakeHooks({ stagePair: () => { throw new EpEnvelopeError("permission-denied", "lifecycle gate moved (barrier retired the holder)"); } });
  await rejects("a retired lifecycle makes the gate-pinned stage LOSE (the lifecycle fence, not a read)", () => redeemSession(g, PRESENTER, hooks), "permission-denied");
  c("…row retired + both ids revoked + marked + nothing released",
    st.rows.get(g.sessionId)!.state === "retired" && st.revoked.join() === "cc1,cs1" && st.rows.get(g.sessionId)!.revoked.caller && st.rows.get(g.sessionId)!.revoked.serving && st.released.length === 0, st);
}
{
  // The ADVERSARIAL two-gate probe: a barrier moves the HOLDER's gate BETWEEN the observation
  // and the stage — the revision pin makes the stage lose. This is the ordering the panel
  // demanded be testable, not an opaque promise.
  const g = await verify(mint());
  const { hooks, st } = fakeHooks();
  const observe = hooks.observeHolderGate;
  hooks.observeHolderGate = async (h) => {
    const pin = await observe(h);
    st.gates.set(pin.key, pin.revision + 1); // the barrier wins right after we looked
    return pin;
  };
  await rejects("a gate moved BETWEEN observation and stage makes the pinned stage LOSE (adversarial ordering probe)", () => redeemSession(g, PRESENTER, hooks), "permission-denied");
  c("…row retired + both ids revoked + nothing released", st.rows.get(g.sessionId)!.state === "retired" && st.revoked.length === 2 && st.released.length === 0, st);
}
{
  // HOLDER EPOCH drift at finalize (fresh-check): pre-check passes, second read moved.
  const g = await verify(mint());
  let reads = 0;
  const { hooks, st } = fakeHooks({ holderProcessEpoch: () => (++reads === 1 ? HOLDER.processEpoch : HOLDER.processEpoch + 1) });
  await rejects("holder restart during redemption refuses at the finalize fresh-check", () => redeemSession(g, PRESENTER, hooks), "expired");
  c("…row went retired + both staged ids revoked, nothing released", st.rows.get(g.sessionId)!.state === "retired" && st.revoked.length === 2 && st.released.length === 0, st);
}
{
  // SERVING EPOCH drift at finalize → superseded.
  const g = await verify(mint());
  let reads = 0;
  const { hooks, st } = fakeHooks({ servingEpoch: () => (++reads === 1 ? SERVING.epoch : SERVING.epoch + 1) });
  await rejects("serving supersession during redemption refuses at finalize", () => redeemSession(g, PRESENTER, hooks), "expired");
  c("…row went superseded + both staged ids revoked", st.rows.get(g.sessionId)!.state === "superseded" && st.revoked.length === 2, st);
}
{
  // EXPIRY AT FINALIZE: passes the pre-check, expires during the (slow) stage — the finalize
  // re-checks currency and refuses; nothing is released.
  const g = await verify(mint());
  let calls = 0;
  const { hooks, st } = fakeHooks({ now: () => (++calls === 1 ? NOW + 10 : NOW + 60_001) });
  await rejects("a grant that expires DURING redemption refuses at the finalize currency re-check", () => redeemSession(g, PRESENTER, hooks), "expired");
  c("…row expired + both ids revoked, nothing released", st.rows.get(g.sessionId)!.state === "expired" && st.revoked.length === 2 && st.released.length === 0, st);
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
  await rejects("a redemption racing a close loses its finalize (conflict), releases nothing", () => redeemSession(g, PRESENTER, hooks), "conflict");
  c("…the racer's terminal state stands + the loser revoked both staged ids, released nothing", base.st.rows.get(g.sessionId)!.state === "closed" && base.st.revoked.length === 2 && base.st.released.length === 0, base.st);
}
{
  // PRE-CHECK refusals burn nothing: wrong holder epoch up front → no alloc, no create, no stage.
  const g = await verify(mint());
  const { hooks, st } = fakeHooks({ holderProcessEpoch: () => HOLDER.processEpoch + 5 });
  await rejects("an unredeemed grant does not survive the caller's restart (pre-check)", () => redeemSession(g, PRESENTER, hooks), "expired");
  c("…nothing allocated/staged, one-use NOT burned", st.alloc === 0 && st.staged === 0 && st.rows.size === 0);
}
{
  // HOSTILE RELEASE HOOKS fail loud: the seam validates what came back, never passes it through.
  const g1 = await verify(mint());
  const wrongId = fakeHooks({ releaseCredential: () => ({ id: "someone-else", creds: "X", exp: NOW + 1000 }) });
  await rejects("a release returning a DIFFERENT credential id fails loud (hook contract)", () => redeemSession(g1, PRESENTER, wrongId.hooks), "contract-invalid");
  const g2 = await verify(mint());
  const longLife = fakeHooks({ releaseCredential: (_s, id) => ({ id, creds: "X", exp: NOW + SESSION_GRANT_MAX_TTL_MS * 2 }) });
  await rejects("a released credential OUTLIVING the session fails loud (cred exp within session exp)", () => redeemSession(g2, PRESENTER, longLife.hooks), "contract-invalid");
  const g3 = await verify(mint());
  const aliased = fakeHooks({ allocateCredentialIds: () => ({ credCaller: "same", credServing: "same" }) });
  await rejects("ALIASED credential ids refuse before the one-use create", () => redeemSession(g3, PRESENTER, aliased.hooks), "contract-invalid");
  c("…nothing created for the aliased pair", aliased.st.rows.size === 0);
}
{
  // RELEASE OUTAGE AFTER FINALIZE is recoverable: the row stays active and the holder's
  // authenticated retry lands on the re-release path — never a torn-down half-session.
  const g = await verify(mint());
  let releases = 0;
  const { hooks, st } = fakeHooks();
  const realRelease = hooks.releaseCredential;
  hooks.releaseCredential = (sid, id) => {
    if (++releases === 1) throw new Error("transient release outage");
    return realRelease(sid, id);
  };
  await rejects("a transient release failure after finalize surfaces (the row stays active)", () => redeemSession(g, PRESENTER, hooks));
  c("…the row is ACTIVE, not torn down", st.rows.get(g.sessionId)!.state === "active");
  c("…and the holder's retry recovers the SAME credential", (await redeemSession(g, PRESENTER, hooks)).id === "cc1");
}
{
  // CRASH MID-ISSUE → the sweep collects: an `issuing` row past exp is transitioned expired
  // and BOTH recorded ids revoked + MARKED; a fully-collected terminal row is untouched.
  const { hooks, st } = fakeHooks();
  const row: SessionLedgerRow = { sessionId: mintSessionId(), endpoint: ENDPOINT, serving: SERVING, holder: { principal: HOLDER.id, lifecycleUid: HOLDER.lifecycleUid }, credCaller: "ccX", credServing: "csX", revoked: { caller: false, serving: false }, state: "issuing", exp: NOW };
  st.rows.set(row.sessionId, row);
  c("sweep collects a crashed half-issue past exp (row expired, BOTH ids revoked + marked)",
    (await sweepSessionRow(row, hooks, { now: NOW + 1 })) === true && st.rows.get(row.sessionId)!.state === "expired" && st.revoked.join() === "ccX,csX" && row.revoked.caller && row.revoked.serving, st);
  c("sweep leaves a fully-collected terminal row alone", (await sweepSessionRow(st.rows.get(row.sessionId)!, hooks, { now: NOW + 999 })) === false);
  const live: SessionLedgerRow = { ...row, sessionId: mintSessionId(), revoked: { caller: false, serving: false }, state: "active", exp: NOW + 60_000 };
  st.rows.set(live.sessionId, live);
  c("sweep leaves an unexpired active row alone", (await sweepSessionRow(live, hooks, { now: NOW })) === false && live.state === "active");
}
{
  // THE REVOKE RETRY IS REAL: one revoke fails during collection; the row goes terminal with
  // one UNMARKED id; the next pass retries EXACTLY that id; the pass after is a no-op. This is
  // the counterexample to "the next sweep retries" being a comment on early-returning code.
  const { hooks, st } = fakeHooks();
  let failOnce = true;
  hooks.revokeCredential = (id) => {
    if (id === "csY" && failOnce) { failOnce = false; throw new Error("revocation outage"); }
    st.revoked.push(id);
  };
  const row: SessionLedgerRow = { sessionId: mintSessionId(), endpoint: ENDPOINT, serving: SERVING, holder: { principal: HOLDER.id, lifecycleUid: HOLDER.lifecycleUid }, credCaller: "ccY", credServing: "csY", revoked: { caller: false, serving: false }, state: "issuing", exp: NOW };
  st.rows.set(row.sessionId, row);
  c("sweep pass 1: row terminal; the FAILED revoke leaves its mark unset",
    (await sweepSessionRow(row, hooks, { now: NOW + 1 })) === true && st.rows.get(row.sessionId)!.state === "expired" && row.revoked.caller === true && row.revoked.serving === false, row);
  c("sweep pass 2 retries EXACTLY the unmarked id on the TERMINAL row",
    (await sweepSessionRow(st.rows.get(row.sessionId)!, hooks, { now: NOW + 2 })) === true && st.rows.get(row.sessionId)!.revoked.serving === true && st.revoked.join() === "ccY,csY", st);
  c("sweep pass 3: fully collected, no-op", (await sweepSessionRow(st.rows.get(row.sessionId)!, hooks, { now: NOW + 3 })) === false);
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
const PORT = await pickFreePort();
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
    // A protocol-invalid PIGGYBACK must have NO application effect: the overrunning ack breaks
    // the rail BEFORE the frame's data reaches onData.
    const gO = { ...grant, sessionId: mintSessionId() };
    const errs: string[] = []; const got: unknown[] = [];
    const serving = openSessionRail({ nc: ncB, grant: gO, role: "serving", onData: (d) => got.push(d), onProtocolError: (r) => errs.push(r) });
    await ncB.flush();
    ncA.publish(epsSubject(SPACE, ENDPOINT, gO.sessionId, SERVING.epoch, "in"), encodeSessionFrame({ t: "f", seq: 1, data: { evil: 1 }, ack: 99 }));
    await ncA.flush();
    c("an overrunning piggyback ack breaks the rail BEFORE the frame's data reaches the app",
      await until(() => errs.includes("credit-overrun")) && got.length === 0, { errs, got });
    serving.close();
  }
  {
    // The APPLICATION accepts FIRST: a throwing handler breaks the rail; the refused frame is
    // neither counted delivered nor credited (the sender must never count it accepted).
    const gH = { ...grant, sessionId: mintSessionId() };
    const credits: number[] = [];
    const watch = ncA.subscribe(epsSubject(SPACE, ENDPOINT, gH.sessionId, SERVING.epoch, "out"), { callback: (_e, m) => { const f = parseSessionFrame(m.data); if (f.t === "credit") credits.push(f.ack); } });
    const errs: string[] = [];
    const serving = openSessionRail({ nc: ncB, grant: gH, role: "serving", onData: () => { throw new Error("app refused the frame"); }, onProtocolError: (r) => errs.push(r), idleCreditMs: 20 });
    await ncA.flush(); await ncB.flush();
    ncA.publish(epsSubject(SPACE, ENDPOINT, gH.sessionId, SERVING.epoch, "in"), encodeSessionFrame({ t: "f", seq: 1, data: { i: 1 } }));
    await ncA.flush();
    c("a throwing handler breaks the rail (handler fault); the frame is NOT counted delivered",
      await until(() => errs.includes("handler")) && serving.stats().delivered === 0, { errs, stats: serving.stats() });
    await wait(100);
    c("…and no credit was ever emitted for the refused frame", credits.length === 0, credits);
    serving.close(); watch.unsubscribe();
  }
  {
    // An ASYNC handler is AWAITED: its rejection refuses the frame exactly like a sync throw —
    // the rail breaks (handler fault) and the frame is neither counted delivered nor credited.
    const gA = { ...grant, sessionId: mintSessionId() };
    const credits: number[] = [];
    const watch = ncA.subscribe(epsSubject(SPACE, ENDPOINT, gA.sessionId, SERVING.epoch, "out"), { callback: (_e, m) => { const f = parseSessionFrame(m.data); if (f.t === "credit") credits.push(f.ack); } });
    const errs: string[] = [];
    const serving = openSessionRail({ nc: ncB, grant: gA, role: "serving", onData: async () => { throw new Error("async app refused the frame"); }, onProtocolError: (r) => errs.push(r), idleCreditMs: 20 });
    await ncA.flush(); await ncB.flush();
    ncA.publish(epsSubject(SPACE, ENDPOINT, gA.sessionId, SERVING.epoch, "in"), encodeSessionFrame({ t: "f", seq: 1, data: { i: 1 } }));
    await ncA.flush();
    c("an ASYNC handler rejection breaks the rail (handler fault); the frame is NOT counted delivered",
      await until(() => errs.includes("handler")) && serving.stats().delivered === 0, { errs, stats: serving.stats() });
    await wait(100);
    c("…and the rejected async frame was never credited", credits.length === 0, credits);
    serving.close(); watch.unsubscribe();
  }
  {
    // Async acceptance is SERIALIZED in seq order: frame 2 arrives while frame 1's handler is
    // still pending — NOT a false gap; nothing advances until the pending handler resolves,
    // then both accept in order.
    const gQ = { ...grant, sessionId: mintSessionId() };
    const order: number[] = [];
    let release1: () => void = () => {};
    const gate1 = new Promise<void>((r) => { release1 = r; });
    const errs: string[] = [];
    const serving = openSessionRail({
      nc: ncB, grant: gQ, role: "serving",
      onData: async (_d, seq) => { if (seq === 1) await gate1; order.push(seq); },
      onProtocolError: (r) => errs.push(r), idleCreditMs: 0,
    });
    await ncB.flush();
    const inQ = epsSubject(SPACE, ENDPOINT, gQ.sessionId, SERVING.epoch, "in");
    ncA.publish(inQ, encodeSessionFrame({ t: "f", seq: 1, data: { i: 1 } }));
    ncA.publish(inQ, encodeSessionFrame({ t: "f", seq: 2, data: { i: 2 } }));
    await ncA.flush();
    await wait(60);
    c("while frame 1's async handler is pending, frame 2 queues (no premature advance, no false gap)",
      serving.stats().delivered === 0 && errs.length === 0, { errs, stats: serving.stats() });
    release1();
    c("frames accept IN ORDER once the pending handler resolves (serialized async acceptance)",
      await until(() => order.length === 2 && serving.stats().delivered === 2) && order[0] === 1 && order[1] === 2, { order, stats: serving.stats() });
    serving.close();
  }
  {
    // The pending-frame queue is BOUNDED by the grant window: a peer that ignores flow control
    // while a handler is wedged cannot pile promises — the over-window frame breaks the rail.
    const gW = { ...grant, sessionId: mintSessionId(), window: 2 };
    const errs: string[] = [];
    const serving = openSessionRail({
      nc: ncB, grant: gW, role: "serving",
      onData: async () => { await new Promise<void>(() => {}); }, // wedged handler: never resolves
      onProtocolError: (r) => errs.push(r), idleCreditMs: 0,
    });
    await ncB.flush();
    const inW = epsSubject(SPACE, ENDPOINT, gW.sessionId, SERVING.epoch, "in");
    ncA.publish(inW, encodeSessionFrame({ t: "f", seq: 1, data: { i: 1 } }));
    ncA.publish(inW, encodeSessionFrame({ t: "f", seq: 2, data: { i: 2 } }));
    ncA.publish(inW, encodeSessionFrame({ t: "f", seq: 3, data: { i: 3 } })); // past the window
    await ncA.flush();
    c("over-window ingress while a handler is wedged breaks the rail (flood), never an unbounded backlog",
      await until(() => errs.includes("flood")) && serving.stats().delivered === 0, { errs, stats: serving.stats() });
    serving.close();
  }
  {
    // A handler resolving AFTER the rail closed advances NOTHING: no watermark, no delivered
    // count, no credit for a frame accepted into a dead rail.
    const gP = { ...grant, sessionId: mintSessionId() };
    const credits: number[] = [];
    const watch = ncA.subscribe(epsSubject(SPACE, ENDPOINT, gP.sessionId, SERVING.epoch, "out"), { callback: (_e, m) => { const f = parseSessionFrame(m.data); if (f.t === "credit") credits.push(f.ack); } });
    let releaseP: () => void = () => {};
    const gateP = new Promise<void>((r) => { releaseP = r; });
    let entered = false;
    const serving = openSessionRail({ nc: ncB, grant: gP, role: "serving", onData: async () => { entered = true; await gateP; }, idleCreditMs: 20 });
    await ncA.flush(); await ncB.flush();
    ncA.publish(epsSubject(SPACE, ENDPOINT, gP.sessionId, SERVING.epoch, "in"), encodeSessionFrame({ t: "f", seq: 1, data: { i: 1 } }));
    await ncA.flush();
    c("…setup: the async handler is mid-flight (entered, unresolved)", await until(() => entered), { entered });
    serving.close(); // the rail dies with the handler in flight
    releaseP(); // the handler resolves into a dead rail
    await wait(100);
    c("a handler resolving AFTER local close advances nothing (no delivered, no credit)",
      serving.stats().delivered === 0 && credits.length === 0, { stats: serving.stats(), credits });
    watch.unsubscribe();
  }
  {
    // A late REJECTION into a closed rail reports NOTHING: the rail is already terminal, and a
    // post-close "handler" fault would double-fault it.
    const gR = { ...grant, sessionId: mintSessionId() };
    const errs: string[] = [];
    let rejectR: (e: Error) => void = () => {};
    const gateR = new Promise<void>((_res, rej) => { rejectR = rej; });
    let entered = false;
    const serving = openSessionRail({ nc: ncB, grant: gR, role: "serving", onData: async () => { entered = true; await gateR; }, onProtocolError: (r) => errs.push(r), idleCreditMs: 20 });
    await ncA.flush(); await ncB.flush();
    ncA.publish(epsSubject(SPACE, ENDPOINT, gR.sessionId, SERVING.epoch, "in"), encodeSessionFrame({ t: "f", seq: 1, data: { i: 1 } }));
    await ncA.flush();
    c("…setup: the handler is pending", await until(() => entered));
    serving.close();
    rejectR(new Error("late rejection"));
    await wait(100);
    c("a handler REJECTING after local close reports nothing (no post-close handler fault)",
      errs.length === 0 && serving.stats().delivered === 0, { errs, stats: serving.stats() });
  }
  {
    // A late REJECTION into a rail a GAP already broke adds NO second terminal fault.
    const gG2 = { ...grant, sessionId: mintSessionId() };
    const errs: string[] = [];
    let rejectG: (e: Error) => void = () => {};
    const gateG = new Promise<void>((_res, rej) => { rejectG = rej; });
    let entered = false;
    const serving = openSessionRail({ nc: ncB, grant: gG2, role: "serving", onData: async () => { entered = true; await gateG; }, onProtocolError: (r) => errs.push(r), idleCreditMs: 20 });
    await ncA.flush(); await ncB.flush();
    const inG2 = epsSubject(SPACE, ENDPOINT, gG2.sessionId, SERVING.epoch, "in");
    ncA.publish(inG2, encodeSessionFrame({ t: "f", seq: 1, data: { i: 1 } }));
    await ncA.flush();
    c("…setup: the handler is pending", await until(() => entered));
    ncA.publish(inG2, encodeSessionFrame({ t: "f", seq: 5, data: { i: 5 } })); // the gap breaks the rail
    await ncA.flush();
    c("…the gap fault surfaces first", await until(() => errs.includes("gap")), errs);
    rejectG(new Error("late rejection"));
    await wait(100);
    c("a handler REJECTING after a rail fault adds NO second terminal fault (the fault list stays ['gap'])",
      errs.length === 1 && errs[0] === "gap" && serving.stats().delivered === 0, { errs, stats: serving.stats() });
    serving.close();
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
    // CREDIT LOSS RECOVERY — mechanism (b) KEEPALIVE, sub-threshold leg: a receiver holding
    // ungranted delivery (below the standalone credit threshold) whose peer has gone quiet
    // advertises its absolute watermark on the idle tick.
    const g8 = { ...grant, sessionId: mintSessionId(), window: 16 };
    const inSubj = epsSubject(SPACE, ENDPOINT, g8.sessionId, SERVING.epoch, "in");
    const outSubj = epsSubject(SPACE, ENDPOINT, g8.sessionId, SERVING.epoch, "out");
    const credits: number[] = [];
    const watch = ncA.subscribe(outSubj, { callback: (_e, msg) => { const f = parseSessionFrame(msg.data); if (f.t === "credit") credits.push(f.ack); } });
    const serving = openSessionRail({ nc: ncB, grant: g8, role: "serving", onData: () => {}, idleCreditMs: 30, stallTimeoutMs: 60_000 });
    await ncA.flush(); await ncB.flush();
    ncA.publish(inSubj, encodeSessionFrame({ t: "f", seq: 1, data: { i: 1 } })); // 1 < creditEvery(8): no standalone threshold credit
    await ncA.flush();
    c("the keepalive advertises the absolute watermark for a quiet peer (sub-threshold delivery)",
      await until(() => credits.includes(1), 3000), credits);
    serving.close(); watch.unsubscribe();
  }
  {
    // CREDIT LOSS RECOVERY — mechanism (b) KEEPALIVE, the DOUBLE-CREDIT-LOSS counterexample
    // (panel round 2): a threshold credit that was EMITTED and then LOST must be re-advertised
    // while the peer stays quiet. A re-emit gated on "newer than what I already emitted" never
    // fires here and the blocked sender stalls forever. window=4 (threshold 2): deliver 2
    // frames (threshold credit ack=2 emitted once), then quiet — the SAME watermark must appear
    // again.
    const gK = { ...grant, sessionId: mintSessionId() }; // window 4 → creditEvery 2
    const inSubj = epsSubject(SPACE, ENDPOINT, gK.sessionId, SERVING.epoch, "in");
    const outSubj = epsSubject(SPACE, ENDPOINT, gK.sessionId, SERVING.epoch, "out");
    const acks: number[] = [];
    const watch = ncA.subscribe(outSubj, { callback: (_e, m) => { const f = parseSessionFrame(m.data); if (f.t === "credit") acks.push(f.ack); } });
    const serving = openSessionRail({ nc: ncB, grant: gK, role: "serving", onData: () => {}, idleCreditMs: 25, stallTimeoutMs: 60_000 });
    await ncA.flush(); await ncB.flush();
    ncA.publish(inSubj, encodeSessionFrame({ t: "f", seq: 1, data: { i: 1 } }));
    ncA.publish(inSubj, encodeSessionFrame({ t: "f", seq: 2, data: { i: 2 } }));
    await ncA.flush();
    c("an ALREADY-EMITTED watermark is re-advertised while the peer is quiet (emitted-credit loss recovers)",
      await until(() => acks.filter((a) => a === 2).length >= 2, 4000), acks);
    serving.close(); watch.unsubscribe();
  }
  {
    // STALL WATCHDOG is TIMER-driven: a sender that fills the window and then only WAITS
    // (never calling send again) still gets the detectable fault.
    const gS = { ...grant, sessionId: mintSessionId(), window: 2 };
    const errs: string[] = [];
    const sub = ncB.subscribe(epsSubject(SPACE, ENDPOINT, gS.sessionId, SERVING.epoch, "in"), { callback: () => {} });
    await ncB.flush();
    const caller = openSessionRail({ nc: ncA, grant: gS, role: "caller", onData: () => {}, onProtocolError: (r) => errs.push(r), idleCreditMs: 20, stallTimeoutMs: 60 });
    caller.send({ i: 1 }); caller.send({ i: 2 }); // fills the window — the send itself arms the watchdog
    c("the stall watchdog fires with NO further send() call (a waiting sender learns its peer is gone)",
      await until(() => errs.includes("stall"), 4000), errs);
    await rejects("…and the broken rail refuses the next send", () => { caller.send({ i: 3 }); }, "failed-precondition");
    caller.close(); sub.unsubscribe();
  }
  {
    // STALL WATCHDOG, send-path belt (injected clock): with the timer's clock frozen, the send
    // path itself surfaces the fault past the timeout.
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
    // PEER-CLOSE TEARDOWN: a remote advisory close clears the local timer + subscription
    // exactly once (not a remotely triggerable per-session leak); a later local close is
    // idempotent.
    const gC2 = { ...grant, sessionId: mintSessionId() };
    let created = 0, cleared = 0, peerClosed = false;
    const rail = openSessionRail({
      nc: ncB, grant: gC2, role: "serving", onData: () => {}, onClose: () => { peerClosed = true; },
      setIntervalFn: (fn, ms) => { created++; return setInterval(fn, ms) as never; },
      clearIntervalFn: (h) => { cleared++; clearInterval(h as ReturnType<typeof setInterval>); },
    });
    await ncB.flush();
    ncA.publish(epsSubject(SPACE, ENDPOINT, gC2.sessionId, SERVING.epoch, "in"), encodeSessionFrame({ t: "close" }));
    await ncA.flush();
    c("a peer advisory close tears down the local timer/subscription (no remotely triggerable leak)",
      await until(() => peerClosed && cleared === 1) && created === 1, { created, cleared, peerClosed });
    rail.close();
    c("…and a later local close is idempotent (no double teardown)", cleared === 1, cleared);
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
