/**
 * The D7 SESSION production auth adapter (SPEC §13.6/§13.12): the first REAL-KV implementation
 * of core's session seams — the {@link SessionLedger} over `session.<sessionId>` rows in the
 * per-space auth store (`cotal_auth_<space>`, `allow_direct=false`, so every read here is
 * leader-served by construction), and the {@link SessionRedemptionHooks} the redemption seam
 * drives: leader-served lifecycle-gate observation, the REVISION-PINNED two-gate stage (the
 * §13.1 fence, the same touch-CAS discipline as the D4 issuance gate: the gate write IS the
 * fence, a moved gate makes the pinned write LOSE), deterministic per-party credential release
 * (Ed25519 JWTs are deterministic, so the idempotent lost-response retry returns the SAME
 * bytes with no secret stored), idempotent revocation marks, the authenticated close op, and
 * the expiry sweep driver.
 *
 * Authority boundaries this module PINS (core enforces the ordering; this adapter makes it
 * durable):
 *  - the `issuing` create IS the one-use; a credential is authority ONLY once its row is
 *    `active` (the connect-time session-credential arm — a named follow-up — checks the row,
 *    and {@link retrieveServingCredential} in core already refuses non-active rows);
 *  - the lifecycle gates (`gate.<lifecycleUid>`) are the D13 registry's keys; this adapter
 *    CONSUMES them (observe/pin/touch). {@link writeLifecycleGate} is the registry's stand-in
 *    for provisioning and smokes until D13 lands, not a public authority surface;
 *  - the gate TOUCH preserves the value and bumps only the revision: it exists so a barrier
 *    that moved the gate between observation and stage LOSES the race durably (§13.1: a read
 *    is never a fence). Concurrent redemptions of the SAME lifecycle serialize on it — the
 *    loser's grant dies (one-use, already burned), which is the fail-loud contract;
 *  - per-session credential rows (`cred.<lifecycleUid>.<sessionId>.<c|s>`) are indexed under
 *    each party's lifecycle, created STAGED before finalize (a later-winning barrier
 *    enumerates and revokes them), and their ids are DETERMINISTIC (uid + sessionId + party),
 *    so a crashed redemption leaves nothing unnameable.
 */
import { Kvm, type KV } from "@nats-io/kv";
import { jetstreamManager } from "@nats-io/jetstream";
import type { NatsConnection } from "@nats-io/transport-node";
import { SignJWT, type CryptoKey } from "jose";
import {
  EpEnvelopeError,
  epAuthBucket,
  epsSubject,
  sessionLedgerKey,
  assertSessionStateTransition,
  sweepSessionRow,
  SESSION_TERMINAL_STATES,
  type SessionGrant,
  type SessionLedger,
  type SessionLedgerRow,
  type SessionRedemptionHooks,
  type SessionCredential,
  type SessionCredentialIds,
  type SessionTerminalState,
  type LifecycleGatePin,
} from "@cotal-ai/core";

const enc = new TextEncoder();
const dec = new TextDecoder();
const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const uint = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** Open the per-space auth store and PROVE its security-critical shape, not merely that some
 *  bucket exists. `Kvm.open` binds lazily, so this forces the bind AND inspects the backing
 *  stream config: the store MUST be `allow_direct=false` (every read here is an authority
 *  read that this module treats as leader-served by construction; a Direct-Get-capable bucket
 *  would let release/close/connect decisions read follower-stale, §13.1) and MUST carry NO
 *  bucket-wide age eviction (an age-evicted `session.`/gate authority key would silently drop a
 *  fence, §13.12). A config-drifted bucket fails loud HERE, never at the first authority read. */
export async function openSessionAuthStore(nc: NatsConnection, space: string): Promise<KV> {
  const bucket = epAuthBucket(space);
  const kv = await new Kvm(nc).open(bucket);
  let cfg: { allow_direct?: boolean; max_age?: number };
  try {
    await kv.status();
    cfg = (await (await jetstreamManager(nc)).streams.info(`KV_${bucket}`)).config;
  } catch (e) {
    throw new EpEnvelopeError("failed-precondition", `the auth store ${bucket} is not provisioned (run space setup; SPEC 13.12): ${(e as Error)?.message ?? String(e)}`);
  }
  if (cfg.allow_direct !== false)
    throw new EpEnvelopeError("failed-precondition", `the auth store ${bucket} has allow_direct=${String(cfg.allow_direct)}, not false; every authority read here must be leader-served, a Direct-Get-capable store defeats read-your-writes (§13.1) — reprovision`);
  if (typeof cfg.max_age === "number" && cfg.max_age > 0)
    throw new EpEnvelopeError("failed-precondition", `the auth store ${bucket} carries bucket-wide age eviction (max_age ${cfg.max_age}); an age-evicted session/gate authority key silently drops a fence (§13.12) — reprovision without MaxAge`);
  return kv;
}

// ---- the session ledger over session.<sessionId> rows ------------------------------------------

function parseRow(raw: Uint8Array, key: string): SessionLedgerRow {
  let o: unknown;
  try {
    o = JSON.parse(dec.decode(raw));
  } catch {
    throw new EpEnvelopeError("internal", `the session row ${key} is not JSON; garbled trusted-path state never authorizes (SPEC 13.3)`);
  }
  if (!isRec(o)) throw new EpEnvelopeError("internal", `the session row ${key} is not an object`);
  const r = o as Partial<SessionLedgerRow> & Record<string, unknown>;
  const states: readonly string[] = ["issuing", "active", ...SESSION_TERMINAL_STATES];
  if (
    typeof r.sessionId !== "string" || typeof r.endpoint !== "string" ||
    !isRec(r.serving) || typeof r.serving.instanceId !== "string" || !uint(r.serving.epoch) ||
    !isRec(r.holder) || typeof r.holder.principal !== "string" || typeof r.holder.lifecycleUid !== "string" ||
    typeof r.credCaller !== "string" || typeof r.credServing !== "string" ||
    !isRec(r.revoked) || typeof r.revoked.caller !== "boolean" || typeof r.revoked.serving !== "boolean" ||
    typeof r.state !== "string" || !states.includes(r.state) || !uint(r.exp)
  )
    throw new EpEnvelopeError("internal", `the session row ${key} does not validate; garbled trusted-path state never authorizes (SPEC 13.3)`);
  return r as SessionLedgerRow;
}

const isCasLoss = (e: unknown): boolean => {
  const code = (e as { api_error?: { err_code?: number } })?.api_error?.err_code;
  return code === 10071 || code === 10164 || /wrong last sequence/i.test((e as Error)?.message ?? "");
};

/** The real-KV {@link SessionLedger}: create-only CAS for the one-use `issuing` row,
 *  revision-pinned CAS for every transition, monotonic states enforced on the write path. */
export function kvSessionLedger(kv: KV): SessionLedger {
  const readEntry = async (sessionId: string) => {
    const entry = await kv.get(sessionLedgerKey(sessionId));
    if (!entry || entry.operation !== "PUT") return undefined;
    return { row: parseRow(entry.value, sessionLedgerKey(sessionId)), revision: entry.revision };
  };
  return {
    async read(sessionId) {
      return (await readEntry(sessionId))?.row;
    },
    async createIssuing(row) {
      try {
        await kv.create(sessionLedgerKey(row.sessionId), enc.encode(JSON.stringify(row)));
        return "created";
      } catch (e) {
        if (isCasLoss(e)) return "exists";
        throw new EpEnvelopeError("unavailable", `the issuing create for session ${row.sessionId} is ambiguous; redemption fails closed (SPEC 13.6): ${(e as Error)?.message ?? String(e)}`);
      }
    },
    async finalizeActive(sessionId) {
      const cur = await readEntry(sessionId);
      if (!cur || cur.row.state !== "issuing") return false;
      try {
        await kv.update(sessionLedgerKey(sessionId), enc.encode(JSON.stringify({ ...cur.row, state: "active" })), cur.revision);
        return true;
      } catch (e) {
        if (isCasLoss(e)) return false; // a racing close/sweep/barrier won
        throw new EpEnvelopeError("unavailable", `the finalize CAS for session ${sessionId} is ambiguous; the redemption fails closed and the sweep collects (SPEC 13.6): ${(e as Error)?.message ?? String(e)}`);
      }
    },
    async transitionTerminal(sessionId, to) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const cur = await readEntry(sessionId);
        if (!cur) return false;
        if ((SESSION_TERMINAL_STATES as readonly string[]).includes(cur.row.state)) return false;
        assertSessionStateTransition(cur.row.state, to);
        try {
          await kv.update(sessionLedgerKey(sessionId), enc.encode(JSON.stringify({ ...cur.row, state: to })), cur.revision);
          return true;
        } catch (e) {
          if (isCasLoss(e)) continue; // re-read: terminal now → false; still live → retry the pin
          throw new EpEnvelopeError("unavailable", `the terminal CAS for session ${sessionId} is ambiguous (SPEC 13.6): ${(e as Error)?.message ?? String(e)}`);
        }
      }
      throw new EpEnvelopeError("unavailable", `the terminal transition for session ${sessionId} kept losing its pin; retry (SPEC 13.6)`);
    },
    async markRevoked(sessionId, credentialId) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const cur = await readEntry(sessionId);
        if (!cur) throw new EpEnvelopeError("failed-precondition", `no session row for ${sessionId}; a revocation mark needs its row (SPEC 13.6)`);
        const which = credentialId === cur.row.credCaller ? "caller" : credentialId === cur.row.credServing ? "serving" : undefined;
        if (which === undefined)
          throw new EpEnvelopeError("failed-precondition", `credential ${credentialId} is not named by session ${sessionId}; marks are by-name (SPEC 13.6)`);
        if (cur.row.revoked[which]) return;
        try {
          await kv.update(sessionLedgerKey(sessionId), enc.encode(JSON.stringify({ ...cur.row, revoked: { ...cur.row.revoked, [which]: true } })), cur.revision);
          return;
        } catch (e) {
          if (isCasLoss(e)) continue;
          throw new EpEnvelopeError("unavailable", `the revocation mark for ${credentialId} is ambiguous; the sweep retries the unmarked id (SPEC 13.6): ${(e as Error)?.message ?? String(e)}`);
        }
      }
      throw new EpEnvelopeError("unavailable", `the revocation mark for ${credentialId} kept losing its pin; the sweep retries (SPEC 13.6)`);
    },
  };
}

// ---- lifecycle gates (the D13 registry's keys; this adapter consumes them) ----------------------

export interface LifecycleGateRow {
  state: "open" | "frozen" | "retired";
  processEpoch: number;
  generation: number;
}

const gateKey = (lifecycleUid: string): string => `gate.${lifecycleUid}`;

function parseGate(raw: Uint8Array, key: string): LifecycleGateRow {
  let o: unknown;
  try {
    o = JSON.parse(dec.decode(raw));
  } catch {
    throw new EpEnvelopeError("internal", `the lifecycle gate ${key} is not JSON (SPEC 13.1)`);
  }
  if (!isRec(o) || !["open", "frozen", "retired"].includes(o.state as string) || !uint(o.processEpoch) || !uint(o.generation))
    throw new EpEnvelopeError("internal", `the lifecycle gate ${key} does not validate (SPEC 13.1)`);
  return o as unknown as LifecycleGateRow;
}

/** The D13 registry's write, stood in for provisioning and smokes (create or replace). NOT a
 *  public authority surface: production gates are written only by the lifecycle registry. */
export async function writeLifecycleGate(kv: KV, lifecycleUid: string, gate: LifecycleGateRow): Promise<void> {
  await kv.put(gateKey(lifecycleUid), enc.encode(JSON.stringify(gate)));
}

async function observeGate(kv: KV, lifecycleUid: string, what: string): Promise<{ pin: LifecycleGatePin; gate: LifecycleGateRow }> {
  const entry = await kv.get(gateKey(lifecycleUid));
  if (!entry || entry.operation !== "PUT")
    throw new EpEnvelopeError("permission-denied", `${what} has no lifecycle issuance gate (${gateKey(lifecycleUid)}); a retired or never-provisioned lifecycle mints nothing (SPEC 13.1)`);
  const gate = parseGate(entry.value, gateKey(lifecycleUid));
  if (gate.state !== "open")
    throw new EpEnvelopeError("permission-denied", `${what}'s lifecycle issuance gate is "${gate.state}"; only an open gate mints (a frozen gate is a barrier in flight, a retired one is terminal, SPEC 13.1)`);
  return { pin: { key: gateKey(lifecycleUid), revision: entry.revision }, gate };
}

// ---- per-session credential rows + the deterministic release ------------------------------------

interface SessionCredRow {
  v: 1;
  kind: "session";
  sessionId: string;
  party: "caller" | "serving";
  /** The signing key id PINNED at stage: release resolves THIS key, so a signer rotation
   *  between the first release and the lost-response retry still yields byte-identical bytes. */
  kid: string;
  state: "staged" | "revoked";
  exp: number;
}

const credKey = (id: string): string => `cred.${id}`;

function parseCredRow(raw: Uint8Array, key: string): SessionCredRow {
  let o: unknown;
  try {
    o = JSON.parse(dec.decode(raw));
  } catch {
    throw new EpEnvelopeError("internal", `the credential row ${key} is not JSON; garbled trusted-path state never authorizes (SPEC 13.3)`);
  }
  if (!isRec(o)) throw new EpEnvelopeError("internal", `the credential row ${key} is not an object`);
  const allowed = new Set(["v", "kind", "sessionId", "party", "kid", "state", "exp"]);
  for (const k of Object.keys(o)) if (!allowed.has(k)) throw new EpEnvelopeError("internal", `the credential row ${key} carries the unknown field "${k}" (closed schema; a garbled trusted write never authorizes, SPEC 13.3)`);
  const r = o as Record<string, unknown>;
  if (r.v !== 1 || r.kind !== "session" || typeof r.sessionId !== "string" || (r.party !== "caller" && r.party !== "serving") ||
      typeof r.kid !== "string" || r.kid.length === 0 || (r.state !== "staged" && r.state !== "revoked") || !uint(r.exp))
    throw new EpEnvelopeError("internal", `the credential row ${key} does not validate; a structurally malformed credential never becomes a signed capability (SPEC 13.3)`);
  return r as unknown as SessionCredRow;
}

/** The adapter's signing identity for released session credentials (EdDSA/Ed25519). Determinism
 *  is the point: Ed25519 signatures are deterministic and the payload is constructed identically
 *  per (session, party), so the idempotent re-release returns byte-identical creds. New stages
 *  pin `current.kid`; release resolves the PINNED kid via `resolve` (rotation-safe: a rotated
 *  signer still reproduces the row's original bytes), returning undefined for an unknown/retired
 *  key so a release whose signing key is gone fails loud rather than re-minting under a new key. */
export interface SessionSigner {
  current: { kid: string; key: CryptoKey };
  resolve(kid: string): CryptoKey | undefined;
}

export interface SessionHookDeps {
  kv: KV;
  /** The space, so the eps rails are RE-DERIVED from durable session coordinates at release,
   *  never trusted from stored subject arrays (a corrupt widened-subjects write cannot become a
   *  signed capability). */
  space: string;
  signer: SessionSigner;
  now?: () => number;
}

/** Build the production {@link SessionRedemptionHooks} over the auth store. */
export function sessionRedemptionHooks(deps: SessionHookDeps): SessionRedemptionHooks {
  const { kv, space, signer } = deps;
  const ledger = kvSessionLedger(kv);
  const now = deps.now
    ? () => { const t = deps.now!(); if (!Number.isSafeInteger(t) || t < 0) throw new EpEnvelopeError("failed-precondition", `the session clock returned ${JSON.stringify(t)}, not a non-negative safe integer; a malformed clock never authorizes (SPEC 13.10)`); return t; }
    : undefined;

  // Re-derive the two eps rails from durable session coordinates (space, endpoint, serving
  // epoch, sessionId) — NEVER the stored subject arrays — so a corrupt credential row cannot
  // sign widened/foreign subjects as authority.
  const railSubjects = (row: SessionLedgerRow, party: "caller" | "serving") => {
    const inSubj = epsSubject(space, row.endpoint, row.sessionId, row.serving.epoch, "in");
    const outSubj = epsSubject(space, row.endpoint, row.sessionId, row.serving.epoch, "out");
    return party === "caller" ? { pub: [inSubj], sub: [outSubj] } : { pub: [outSubj], sub: [inSubj] };
  };

  const release = async (sessionId: string, credentialId: string): Promise<SessionCredential> => {
    const rowEntry = await kv.get(sessionLedgerKey(sessionId));
    if (!rowEntry || rowEntry.operation !== "PUT")
      throw new EpEnvelopeError("failed-precondition", `no session row for ${sessionId}; nothing releases without its authority row (SPEC 13.6)`);
    const row = parseRow(rowEntry.value, sessionLedgerKey(sessionId));
    if (row.state !== "active")
      throw new EpEnvelopeError("failed-precondition", `session ${sessionId} is "${row.state}", not active; a credential is authority only once its row is active (SPEC 13.6)`);
    const credEntry = await kv.get(credKey(credentialId));
    if (!credEntry || credEntry.operation !== "PUT")
      throw new EpEnvelopeError("failed-precondition", `credential ${credentialId} has no staged row; release follows the stage, never invents (SPEC 13.6)`);
    const cred = parseCredRow(credEntry.value, credKey(credentialId));
    if (cred.sessionId !== sessionId)
      throw new EpEnvelopeError("internal", `credential ${credentialId} names session ${cred.sessionId}, not ${sessionId}; a mis-bound credential never authorizes (SPEC 13.6)`);
    if (cred.state === "revoked")
      throw new EpEnvelopeError("permission-denied", `credential ${credentialId} is revoked; a revoked half never re-releases (SPEC 13.6)`);
    const key = signer.resolve(cred.kid);
    if (key === undefined)
      throw new EpEnvelopeError("unavailable", `the signing key ${cred.kid} pinned by credential ${credentialId} is not resolvable; release fails closed rather than re-minting under a different key (SPEC 13.6/13.10)`);
    // DETERMINISTIC mint under the PINNED key: identical payload + EdDSA => identical bytes on
    // every re-release. Subjects RE-DERIVED from the row, never trusted from storage.
    const jwt = await new SignJWT({ act: { kind: "session", sessionId, party: cred.party, subjects: railSubjects(row, cred.party) } })
      .setProtectedHeader({ alg: "EdDSA", kid: cred.kid })
      .setSubject(cred.party === "caller" ? row.holder.principal : row.endpoint)
      .setExpirationTime(Math.floor(row.exp / 1000))
      .sign(key);
    return { id: credentialId, creds: jwt, exp: row.exp };
  };

  return {
    ledger,
    allocateCredentialIds(grant) {
      // DETERMINISTIC, distinct, bounded, and key-recoverable: the id embeds the party's
      // lifecycle uid, so revocation-by-name needs no side index and a redemption retry
      // re-allocates the SAME names (no orphan ids).
      return {
        credCaller: `${grant.holder.lifecycleUid}.${grant.sessionId}.c`,
        credServing: `${grant.serving.instanceId}.${grant.sessionId}.s`,
      };
    },
    async holderProcessEpoch(holder) {
      const entry = await kv.get(gateKey(holder.lifecycleUid));
      if (!entry || entry.operation !== "PUT") return undefined;
      return parseGate(entry.value, gateKey(holder.lifecycleUid)).processEpoch;
    },
    async servingEpoch(_endpoint, instanceId) {
      const entry = await kv.get(gateKey(instanceId));
      if (!entry || entry.operation !== "PUT") return undefined;
      return parseGate(entry.value, gateKey(instanceId)).processEpoch;
    },
    async observeHolderGate(holder) {
      return (await observeGate(kv, holder.lifecycleUid, `holder ${holder.id}`)).pin;
    },
    async observeServingGate(endpoint, instanceId) {
      return (await observeGate(kv, instanceId, `serving ${endpoint}/${instanceId}`)).pin;
    },
    async stagePair(grant, ids, pins) {
      // Stage both credential rows CREATE-ONLY (indexed under each lifecycle; staged rows
      // confer nothing), then TOUCH-CAS both gates pinned at their observed revisions: the
      // gate write IS the §13.1 fence — a barrier that moved either gate since observation
      // makes the pinned touch LOSE, and the redemption collects and refuses.
      const stage = async (id: string, party: "caller" | "serving") => {
        const value: SessionCredRow = { v: 1, kind: "session", sessionId: grant.sessionId, party, kid: signer.current.kid, state: "staged", exp: grant.exp };
        try {
          await kv.create(credKey(id), enc.encode(JSON.stringify(value)));
        } catch (e) {
          if (!isCasLoss(e))
            throw new EpEnvelopeError("unavailable", `staging credential ${id} is ambiguous (SPEC 13.6): ${(e as Error)?.message ?? String(e)}`);
          // A create loss here is a RETRY over this session's own deterministic ids (the
          // one-use already fenced foreign sessions): verify byte identity, else fail loud.
          const existing = await kv.get(credKey(id));
          if (!existing || dec.decode(existing.value) !== JSON.stringify(value))
            throw new EpEnvelopeError("conflict", `credential row ${id} exists with FOREIGN content; a staged name never silently re-binds (SPEC 13.6)`);
        }
      };
      await stage(ids.credCaller, "caller");
      await stage(ids.credServing, "serving");
      // Touch each DISTINCT gate key ONCE, in CANONICAL (sorted) order. Deduping is essential:
      // a self-session whose holder and serving name the SAME gate would otherwise touch it
      // twice and the second touch would deterministically lose its own now-bumped pin.
      // Canonical order prevents the crossed-pair livelock (two reciprocal redemptions each
      // winning one gate and losing the other, burning BOTH one-uses with no barrier): both
      // contend the lexicographically-first key first, so exactly one wins and proceeds.
      const byKey = new Map<string, number>();
      for (const pin of [pins.holder, pins.serving]) {
        const seen = byKey.get(pin.key);
        if (seen !== undefined && seen !== pin.revision)
          throw new EpEnvelopeError("internal", `the same gate ${pin.key} was observed at two revisions (${seen} vs ${pin.revision}); a single observation feeds the pinned touch (SPEC 13.1)`);
        byKey.set(pin.key, pin.revision);
      }
      for (const key of [...byKey.keys()].sort()) {
        const revision = byKey.get(key)!;
        const entry = await kv.get(key);
        if (!entry || entry.operation !== "PUT" || entry.revision !== revision)
          throw new EpEnvelopeError("permission-denied", `the lifecycle gate ${key} moved since its observation (revision ${entry?.revision ?? "gone"} vs pinned ${revision}); the staged pair loses (SPEC 13.1)`);
        try {
          await kv.update(key, entry.value, revision);
        } catch (e) {
          if (isCasLoss(e))
            throw new EpEnvelopeError("permission-denied", `the lifecycle gate ${key} moved during the stage; the pinned write LOSES (SPEC 13.1)`);
          throw new EpEnvelopeError("unavailable", `the gate touch for ${key} is ambiguous; redemption fails closed (SPEC 13.1): ${(e as Error)?.message ?? String(e)}`);
        }
      }
    },
    releaseCredential: release,
    async revokeCredential(id) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const entry = await kv.get(credKey(id));
        if (!entry || entry.operation !== "PUT") return; // a dead id re-revokes successfully (idempotent)
        const cred = parseCredRow(entry.value, credKey(id));
        if (cred.state === "revoked") return;
        try {
          await kv.update(credKey(id), enc.encode(JSON.stringify({ ...cred, state: "revoked" })), entry.revision);
          return;
        } catch (e) {
          if (isCasLoss(e)) continue;
          throw new EpEnvelopeError("unavailable", `revoking ${id} is ambiguous; the sweep retries the unmarked half (SPEC 13.6): ${(e as Error)?.message ?? String(e)}`);
        }
      }
      throw new EpEnvelopeError("unavailable", `revoking ${id} kept losing its pin; the sweep retries (SPEC 13.6)`);
    },
    ...(now ? { now } : {}),
  };
}

// ---- the authenticated close op + the expiry sweep ----------------------------------------------

/** The authenticated presenter of a close: one of the session's two parties (their identity
 *  established by the auth path's own context, §9/§10) or the operator. */
export type SessionCloser =
  | { kind: "holder"; id: string; lifecycleUid: string }
  | { kind: "serving"; endpoint: string; instanceId: string; epoch: number }
  | { kind: "operator" };

/**
 * The §13.6 authoritative close: verify party membership against the AUTHORITATIVE row (never
 * a caller projection), transition the row terminal, and revoke BOTH credentials by name, each
 * marked on success (the sweep's terminal-row retry backstops any failure). Idempotent for an
 * already-terminal row (`transitioned: false`, the marks still retried).
 */
export async function closeSession(
  hooks: Pick<SessionRedemptionHooks, "ledger" | "revokeCredential">,
  args: { sessionId: string; closer: SessionCloser; to?: SessionTerminalState },
): Promise<{ transitioned: boolean; fullyRevoked: boolean }> {
  const row = await hooks.ledger.read(args.sessionId);
  if (row === undefined)
    throw new EpEnvelopeError("not-found", `session ${args.sessionId} has no ledger row (SPEC 13.6)`);
  const c = args.closer;
  const member =
    c.kind === "operator" ||
    (c.kind === "holder" && c.id === row.holder.principal && c.lifecycleUid === row.holder.lifecycleUid) ||
    (c.kind === "serving" && c.endpoint === row.endpoint && c.instanceId === row.serving.instanceId && c.epoch === row.serving.epoch);
  if (!member)
    throw new EpEnvelopeError("permission-denied", `the presenter is not a party to session ${args.sessionId} (close is party- or operator-authenticated against the ledger row, SPEC 13.6)`);
  const transitioned = await hooks.ledger.transitionTerminal(args.sessionId, args.to ?? "closed");
  // Revoke both halves; report whether containment COMPLETED. The row transition blocks NEW
  // release/connect, but a mint-time revocation is not verified live eviction of an
  // already-connected peer (that is the §13.1 barrier's evictPrincipal step, the named D13
  // wiring). Close does NOT silently claim success when a revoke failed: `fullyRevoked` is
  // false and the unmarked half is the sweep's durable retry backstop, so the caller can
  // surface the incomplete containment rather than trust a timer.
  const after = await hooks.ledger.read(args.sessionId);
  let fullyRevoked = true;
  if (after) {
    for (const [id, marked] of [[after.credCaller, after.revoked.caller], [after.credServing, after.revoked.serving]] as const) {
      if (marked) continue;
      try {
        await hooks.revokeCredential(id);
        await hooks.ledger.markRevoked(args.sessionId, id);
      } catch {
        fullyRevoked = false; // the unmarked id is the sweep's retry backstop; close reports incomplete
      }
    }
  } else {
    fullyRevoked = false;
  }
  return { transitioned, fullyRevoked };
}

/** Enumerate `session.>` and run core's per-row sweep decision: expiry transitions + the
 *  terminal-row unmarked-id revoke retry. Corruption is LOUD but LOCAL: a single malformed row
 *  is collected and reported, never allowed to abort containment of the other valid rows (else
 *  one poison row would block the whole bucket's expiry/revocation backstop). Returns how many
 *  rows this pass acted on plus the keys that failed. */
export async function sweepSessions(
  kv: KV,
  hooks: Pick<SessionRedemptionHooks, "ledger" | "revokeCredential">,
  opts: { now: number; marginMs?: number },
): Promise<{ acted: number; failed: string[] }> {
  if (!Number.isSafeInteger(opts.now) || opts.now < 0)
    throw new EpEnvelopeError("failed-precondition", `the sweep clock ${JSON.stringify(opts.now)} is not a non-negative safe integer; a malformed clock would expire live rows or spare dead ones (SPEC 13.6)`);
  if (opts.marginMs !== undefined && (!Number.isSafeInteger(opts.marginMs) || opts.marginMs < 0))
    throw new EpEnvelopeError("failed-precondition", `the sweep margin ${JSON.stringify(opts.marginMs)} is not a non-negative safe integer (SPEC 13.6)`);
  let acted = 0;
  const failed: string[] = [];
  const keys = await kv.keys("session.>");
  for await (const key of keys) {
    try {
      const entry = await kv.get(key);
      if (!entry || entry.operation !== "PUT") continue;
      const row = parseRow(entry.value, key);
      if (await sweepSessionRow(row, hooks, opts)) acted++;
    } catch {
      failed.push(key); // one poison row never blocks the rest of the bucket's containment
    }
  }
  return { acted, failed };
}
