/**
 * The SESSION (bidirectional stream) composite (SPEC §13.6): D26's cast-ingress + watch-egress
 * composed over dedicated per-session subjects — no new verb, no new transport. The `in`
 * subject is a cast-only rail (caller publishes, serving endpoint subscribes) and `out` is a
 * watch rail (endpoint publishes, caller subscribes); both are epoch-pinned
 * (`eps.<endpoint>.<sessionId>.<epoch>.<in|out>`), CORE-ONLY, never stream-captured.
 *
 * The module owns the transport-thin core:
 *
 *  - the SESSION GRANT: a one-use, holder-bound signed artifact (RFC 8785 + Ed25519 via the
 *    §13.10 anchor registry, role `sessions`) naming a fresh unguessable `sessionId`, BOTH
 *    epoch-pinned rail subjects (carried explicitly AND re-derived at verification — a
 *    substituted subject kills the signature or the derivation check), the holder's
 *    (principal, lifecycleUid, processEpoch) and the serving (instanceId, epoch). Live
 *    authority: an unredeemed grant dies with the caller's restart (§13.1), so redemption
 *    fresh-checks the holder epoch.
 *  - the SESSION LEDGER ROW contract (`session.<sessionId>` in the auth store, §13.12):
 *    `{sessionId, serving, holder, both credential ids, state, exp}` with the monotonic state
 *    grammar `issuing → active → closed|expired|superseded|retired` (all terminal). The
 *    create-CAS of the `issuing` row IS the one-use redemption; the finalize-CAS
 *    `issuing → active` fresh-checks BOTH process epochs and both lifecycle gates and releases
 *    the two credentials only on success. A credential is authority ONLY once its row is
 *    `active`; an `issuing` row confers nothing (the auth path's connect boundary enforces
 *    that; this module pins the contract and the ordering). A crash mid-issue leaves an
 *    `issuing` row the expiry sweep collects (revoking BOTH ids by name and tombstoning),
 *    never a live half-pair; a redemption racing a close loses its finalize and releases
 *    nothing.
 *  - the REDEMPTION SEAM ({@link redeemSession}): core owns the ordering and the refusal
 *    catalog; the trusted auth path (§9/§10, off-broker) wires the real KV create/finalize
 *    CAS, the credential mint (each per-session credential is simultaneously a
 *    credential-ledger row under its holder's lifecycle — the §13.1 barrier index), and
 *    revocation. The same seam pattern as D4's issuance gate.
 *  - the RAILS + BOUNDED FLOW WINDOW ({@link openSessionRail}): a tiny framed protocol over
 *    OPAQUE data (`{t:"f",seq,data}`), credit-based sliding window sized by the grant
 *    (`window`, 1..{@link SESSION_WINDOW_MAX}); a sender whose window is full REFUSES with
 *    `resource-exhausted` — in-memory state, NO buffering, never unbounded (§13.6). Credits
 *    (`{t:"credit",ack}`) ride the sender's own ingress rail (both rails exist, so control
 *    needs no extra grant) and are EXEMPT from the window (control, not data). The receiver
 *    acks CONTIGUOUS delivery only, so a dropped frame stalls credits and the sender windows
 *    out loudly: the window doubles as the loss detector; there is no retransmit machinery —
 *    a broken session is closed and re-established (a durable session is a NEW
 *    establishment; the epoch is in the subject, so a restarted instance cannot resume).
 *  - CLOSE: the in-band `{t:"close"}` frame is an ADVISORY peer signal, never the revocation
 *    authority (EPS subjects are captured by nothing). Authoritative close/expiry live on the
 *    trusted auth path: an authenticated close op (a session party or the operator names the
 *    sessionId; party membership is verified against the ledger row), the auth path's own
 *    expiry timer, or either side's §13.1 barrier — each transitions the row terminal and
 *    revokes BOTH credentials, so neither side can keep a half-closed session alive and a
 *    crashed serving endpoint cannot orphan one (the ledger, not the endpoint, remembers what
 *    to revoke).
 */
import { randomBytes } from "node:crypto";
import type { NatsConnection, Subscription } from "@nats-io/transport-node";
import { EpEnvelopeError } from "./endpoint-envelope.js";
import { canonicalJson } from "./canonical.js";
import {
  epsSubject,
  assertIdToken,
  assertLifecycleToken,
  endpointToken,
  type EpSessionDir,
} from "./endpoint-subjects.js";
import {
  verifyArtifactSignature,
  resolveAnchorForUse,
  assertAnchorScopeCovers,
  signArtifact,
  type AnchorResolver,
} from "./endpoint-signing.js";

const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
function invalid(what: string): never {
  throw new EpEnvelopeError("contract-invalid", `${what} (SPEC 13.6 session)`);
}

// ---- bounds (fail loud past each; a bound reached is a refusal, never a truncation) ----------

/** Grant validity ceiling — a session grant is LIVE-class authority (§13.6 "expiry per the
 *  handle rules"; it is one-use and epoch-bound on both sides, never sturdy). */
export const SESSION_GRANT_MAX_TTL_MS = 24 * 60 * 60 * 1000;
export const SESSION_GRANT_MAX_BYTES = 16 * 1024;
/** The bounded flow window (§13.6: declared in the grant; overflow is `resource-exhausted`). */
export const SESSION_WINDOW_DEFAULT = 64;
export const SESSION_WINDOW_MAX = 1024;

/** Mint a fresh unguessable sessionId: 32 CSPRNG bytes, base64url (43 chars, within the
 *  bounded id-token grammar the subject builder pins). */
export function mintSessionId(): string {
  return assertIdToken(randomBytes(32).toString("base64url"), "sessionId");
}

// ---- the session grant artifact --------------------------------------------------------------

/** The §13.6/§13.10 session grant: one-use, holder-bound, epoch-pinned on BOTH sides. */
export interface SessionGrant {
  v: 1;
  sessionId: string;
  space: string;
  endpoint: string;
  /** BOTH rail subjects, explicit in the signed form AND re-derived at verification. */
  subjects: { in: string; out: string };
  /** The redeeming caller: live authority — bound to lifecycle AND current process epoch. */
  holder: { id: string; lifecycleUid: string; processEpoch: number };
  /** The serving instance the session is pinned to; the epoch rides the subjects too. */
  serving: { instanceId: string; epoch: number };
  /** Max in-flight (unacknowledged) data frames per direction. */
  window: number;
  iat: number;
  nbf?: number;
  exp: number;
  /** Freshness/anti-replay token for the establishment exchange (the one-use is the ledger
   *  create-CAS; the nonce only disambiguates re-issued grants for the same pair). */
  nonce: string;
  /** Signing key (anchor registry, role `sessions`). */
  issuer: { keyId: string };
  sig: string;
}

/** Everything {@link mintSessionGrant} needs besides the signing key. */
export interface MintSessionGrantArgs {
  space: string;
  endpoint: string;
  sessionId?: string;
  holder: { id: string; lifecycleUid: string; processEpoch: number };
  serving: { instanceId: string; epoch: number };
  window?: number;
  ttlMs: number;
  issuerKeyId: string;
  now?: number;
}

function assertWindow(v: unknown): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1 || v > SESSION_WINDOW_MAX)
    invalid(`window ${String(v)} is not an integer in 1..${SESSION_WINDOW_MAX}`);
  return v;
}

/** The subject grammar's epoch bound (unsigned safe integer), as a value validator — the
 *  subject builder re-asserts it when the rails are derived. */
function assertEpochInt(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) invalid(`${what} ${String(v)} is not an unsigned integer epoch`);
  return v;
}

function assertHolderId(id: unknown): string {
  if (typeof id !== "string" || id.length === 0 || id.length > 256) invalid("holder.id is not a bounded principal string");
  return id;
}

/** Build + sign a session grant (the serving side's establishment answer). The rail subjects
 *  are DERIVED here — the signature pins them; a verifier re-derives and compares. */
export function mintSessionGrant(
  args: MintSessionGrantArgs,
  keyPair: { sign(input: Uint8Array): Uint8Array },
): SessionGrant {
  const now = args.now ?? Date.now();
  if (!Number.isSafeInteger(now)) invalid("now is not an integer");
  if (!Number.isSafeInteger(args.ttlMs) || args.ttlMs <= 0 || args.ttlMs > SESSION_GRANT_MAX_TTL_MS)
    invalid(`ttlMs ${String(args.ttlMs)} is not in (0, ${SESSION_GRANT_MAX_TTL_MS}]`);
  const sessionId = args.sessionId !== undefined ? assertIdToken(args.sessionId, "sessionId") : mintSessionId();
  const endpoint = endpointToken(args.endpoint);
  const serving = {
    instanceId: assertLifecycleToken(args.serving.instanceId, "serving.instanceId"),
    epoch: assertEpochInt(args.serving.epoch, "serving.epoch"),
  };
  const holder = {
    id: assertHolderId(args.holder.id),
    lifecycleUid: assertLifecycleToken(args.holder.lifecycleUid, "holder.lifecycleUid"),
    processEpoch: assertEpochInt(args.holder.processEpoch, "holder.processEpoch"),
  };
  const unsigned = {
    v: 1 as const,
    sessionId,
    space: args.space,
    endpoint,
    subjects: {
      in: epsSubject(args.space, endpoint, sessionId, serving.epoch, "in"),
      out: epsSubject(args.space, endpoint, sessionId, serving.epoch, "out"),
    },
    holder,
    serving,
    window: assertWindow(args.window ?? SESSION_WINDOW_DEFAULT),
    iat: now,
    exp: now + args.ttlMs,
    nonce: randomBytes(18).toString("base64url"),
    issuer: { keyId: args.issuerKeyId },
  };
  return signArtifact(unsigned, keyPair);
}

/** Parse + verify a presented session grant, D28-exact: the signature verifies over the EXACT
 *  raw artifact (sig absent), the parsed projection is for semantics only; the anchor is
 *  resolved FRESH (role `sessions`, scope ceiling covers the endpoint); the rail subjects are
 *  re-derived and compared; currency is checked at `now`. Fail-closed everywhere. */
export async function verifySessionGrant(
  raw: unknown,
  opts: { space: string; resolveAnchor: AnchorResolver; now?: number },
): Promise<SessionGrant> {
  const now = opts.now ?? Date.now();
  if (!isRec(raw)) invalid("a session grant is not an object");
  // Byte bound BEFORE any structural walk (a canonicalization failure is contract-invalid too:
  // an artifact that cannot canonicalize cannot have been signed).
  let canonical: string;
  try {
    const { sig: _sig, ...rest } = raw as Record<string, unknown>;
    canonical = canonicalJson(rest);
  } catch (e) {
    invalid(`session grant does not canonicalize: ${(e as Error)?.message ?? String(e)}`);
  }
  if (canonical.length > SESSION_GRANT_MAX_BYTES) invalid(`session grant exceeds ${SESSION_GRANT_MAX_BYTES} bytes`);

  const o = raw as Record<string, unknown>;
  const allowed = new Set(["v", "sessionId", "space", "endpoint", "subjects", "holder", "serving", "window", "iat", "nbf", "exp", "nonce", "issuer", "sig"]);
  for (const k of Object.keys(o)) if (!allowed.has(k)) invalid(`session grant carries the unknown field "${k}" (closed schema)`);
  if (o.v !== 1) invalid(`unknown session grant version ${String(o.v)}`);
  if (typeof o.space !== "string" || o.space.length === 0) invalid("space is not a string");
  if (o.space !== opts.space) throw new EpEnvelopeError("permission-denied", `session grant is for space "${o.space}", not "${opts.space}" (audience, SPEC 13.6)`);
  const sessionId = assertIdToken(o.sessionId as string, "sessionId");
  const endpoint = endpointToken(o.endpoint as string);
  if (!isRec(o.serving)) invalid("serving is not an object");
  const serving = {
    instanceId: assertLifecycleToken((o.serving as Record<string, unknown>).instanceId as string, "serving.instanceId"),
    epoch: assertEpochInt((o.serving as Record<string, unknown>).epoch, "serving.epoch"),
  };
  if (!isRec(o.holder)) invalid("holder is not an object");
  const h = o.holder as Record<string, unknown>;
  const holder = {
    id: assertHolderId(h.id),
    lifecycleUid: assertLifecycleToken(h.lifecycleUid as string, "holder.lifecycleUid"),
    processEpoch: assertEpochInt(h.processEpoch, "holder.processEpoch"),
  };
  if (!isRec(o.subjects)) invalid("subjects is not an object");
  const subj = o.subjects as Record<string, unknown>;
  for (const k of Object.keys(subj)) if (k !== "in" && k !== "out") invalid(`subjects carries the unknown key "${k}"`);
  const expectIn = epsSubject(o.space, endpoint, sessionId, serving.epoch, "in");
  const expectOut = epsSubject(o.space, endpoint, sessionId, serving.epoch, "out");
  if (subj.in !== expectIn || subj.out !== expectOut)
    throw new EpEnvelopeError("permission-denied", "session grant subjects do not match the derived epoch-pinned rails; a substituted subject never verifies (SPEC 13.6)");
  const window = assertWindow(o.window);
  if (typeof o.iat !== "number" || !Number.isSafeInteger(o.iat)) invalid("iat is not an integer");
  if (o.nbf !== undefined && (typeof o.nbf !== "number" || !Number.isSafeInteger(o.nbf))) invalid("nbf is not an integer");
  if (typeof o.exp !== "number" || !Number.isSafeInteger(o.exp)) invalid("exp is not an integer");
  if (o.exp - o.iat > SESSION_GRANT_MAX_TTL_MS) invalid(`session grant validity exceeds the ${SESSION_GRANT_MAX_TTL_MS}ms live ceiling`);
  if (typeof o.nonce !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(o.nonce)) invalid("nonce is not a bounded base64url token");
  if (!isRec(o.issuer) || typeof (o.issuer as Record<string, unknown>).keyId !== "string") invalid("issuer.keyId is not a string");

  // Anchor gate: fresh resolution, role, window-at-signing, revocation-at-verification, and
  // the sessions scope ceiling covers THIS endpoint (an absent dimension is closed).
  const anchor = await resolveAnchorForUse(opts.resolveAnchor, { keyId: (o.issuer as { keyId: string }).keyId, role: "sessions", at: o.iat });
  assertAnchorScopeCovers(anchor, "sessions", endpoint, "the session's endpoint");
  verifyArtifactSignature(o, anchor);

  // Currency LAST (after identity): a forged-but-expired artifact is permission-denied above,
  // never a soft "expired" that leaks verification order.
  const nbf = (o.nbf as number | undefined) ?? (o.iat as number);
  if (now < nbf) throw new EpEnvelopeError("failed-precondition", `session grant is not yet valid (nbf ${nbf}, now ${now})`);
  if (now > (o.exp as number)) throw new EpEnvelopeError("expired", `session grant expired at ${o.exp as number} (now ${now})`);

  return {
    v: 1,
    sessionId,
    space: o.space,
    endpoint,
    subjects: { in: expectIn, out: expectOut },
    holder,
    serving,
    window,
    iat: o.iat,
    ...(o.nbf !== undefined ? { nbf: o.nbf as number } : {}),
    exp: o.exp,
    nonce: o.nonce,
    issuer: { keyId: (o.issuer as { keyId: string }).keyId },
    sig: o.sig as string,
  };
}

// ---- the session ledger row (auth store `session.<sessionId>`, §13.12) -----------------------

export const SESSION_TERMINAL_STATES = ["closed", "expired", "superseded", "retired"] as const;
export type SessionTerminalState = (typeof SESSION_TERMINAL_STATES)[number];
export type SessionState = "issuing" | "active" | SessionTerminalState;

/** The durable revocation authority that survives the serving endpoint (§13.6). Both
 *  credential ids are recorded FROM CREATION (the `issuing` write), so a crash at any later
 *  point leaves a row that names exactly what the sweep must revoke. */
export interface SessionLedgerRow {
  sessionId: string;
  serving: { instanceId: string; epoch: number };
  holder: { principal: string; lifecycleUid: string };
  credCaller: string;
  credServing: string;
  state: SessionState;
  exp: number;
}

/** The auth-store key (`session.<sessionId>`, §13.12). */
export function sessionLedgerKey(sessionId: string): string {
  return `session.${assertIdToken(sessionId, "sessionId")}`;
}

/** The monotonic state grammar: `issuing → active`, `issuing → terminal` (the sweep collecting
 *  a crashed half-issue), `active → terminal`. Terminal states never transition. */
export function assertSessionStateTransition(from: SessionState, to: SessionState): void {
  const terminal = (SESSION_TERMINAL_STATES as readonly string[]).includes(from);
  if (terminal)
    throw new EpEnvelopeError("failed-precondition", `session state "${from}" is terminal; states are monotonic (SPEC 13.6)`);
  if (to === "issuing")
    throw new EpEnvelopeError("failed-precondition", `no transition re-enters "issuing" (the create-CAS is the only writer of that state, SPEC 13.6)`);
  if (from === "active" && to === "active")
    throw new EpEnvelopeError("failed-precondition", `session is already active (finalize is one-shot, SPEC 13.6)`);
}

// ---- the redemption seam ----------------------------------------------------------------------

type MaybePromise<T> = T | Promise<T>;

/** The auth path's durable half: real implementations back this with the auth-store KV
 *  (create-only CAS / revision-pinned update); smokes supply a faithful in-memory fake. */
export interface SessionLedger {
  /** Create-only CAS of the `issuing` row. `"exists"` = the one-use is already burned. */
  createIssuing(row: SessionLedgerRow): MaybePromise<"created" | "exists">;
  /** CAS `issuing → active`. `false` = the row moved under us (a close/sweep raced the
   *  finalize; the redemption LOSES and releases nothing). */
  finalizeActive(sessionId: string): MaybePromise<boolean>;
  /** CAS the row to a terminal state (close/expiry/barrier/abandoned redemption). `false` =
   *  already terminal (idempotent for the caller's purposes). */
  transitionTerminal(sessionId: string, to: SessionTerminalState): MaybePromise<boolean>;
}

/** The two per-session credential IDs (the credential-ledger ids revocation names). Allocated
 *  BEFORE the one-use `issuing` create, so the row names both from its first durable write and a
 *  crash at any later point leaves the sweep able to revoke the whole pair. */
export interface SessionCredentialIds {
  credCaller: string;
  credServing: string;
}

/** One released per-session credential: the id revocation names + the usable creds bytes. A
 *  credential is authority ONLY once its session row is `active`; nothing releases usable bytes
 *  before finalize (an `issuing` row confers nothing). */
export interface SessionCredential {
  id: string;
  creds: string;
}

/** The auth path's durable half: real implementations back this with the auth-store KV
 *  (create-only CAS / revision-pinned update); smokes supply a faithful in-memory fake. */
export interface SessionLedger {
  /** Create-only CAS of the `issuing` row (naming BOTH credential ids). `"exists"` = the
   *  one-use is already burned. */
  createIssuing(row: SessionLedgerRow): MaybePromise<"created" | "exists">;
  /** CAS `issuing → active`. `false` = the row moved under us (a close/sweep/barrier raced the
   *  finalize; the redemption LOSES and releases nothing). */
  finalizeActive(sessionId: string): MaybePromise<boolean>;
  /** CAS the row to a terminal state (close/expiry/barrier/abandoned redemption). `false` =
   *  already terminal (idempotent for the caller's purposes). */
  transitionTerminal(sessionId: string, to: SessionTerminalState): MaybePromise<boolean>;
}

/**
 * Everything {@link redeemSession} needs from the trusted auth path. The LIFECYCLE FENCE is the
 * gate-pinned {@link stagePair} write (a moved lifecycle issuance gate makes it LOSE), NOT a
 * boolean read — fresh reads are not fences (§13.1/§13.9). The process-epoch reads ARE fencing
 * reads and MUST be leader-served (the auth bucket `allow_direct=false` → `STREAM.MSG.GET`, per
 * the §13.9 read-service class), never a follower Direct Get. Every hook re-runs FRESH at
 * finalize; a cached answer would reopen the §13.1 window.
 */
export interface SessionRedemptionHooks {
  ledger: SessionLedger;
  /** Allocate the two credential-ledger ids for this session (bounded ids, NO usable bytes) so
   *  the `issuing` row can name both from its first write. */
  allocateCredentialIds(grant: SessionGrant): MaybePromise<SessionCredentialIds>;
  /** The holder's CURRENT process epoch (leader-served read), or undefined when the lifecycle
   *  has no live process. */
  holderProcessEpoch(holder: { id: string; lifecycleUid: string }): MaybePromise<number | undefined>;
  /** The serving instance's CURRENT epoch (leader-served read), or undefined when it is not
   *  registered/live. */
  servingEpoch(endpoint: string, instanceId: string): MaybePromise<number | undefined>;
  /** Stage BOTH per-session credential-ledger rows, each a GATE-PINNED CAS against its party's
   *  lifecycle issuance gate (§13.1): caller = pub `in` + sub `out` EXACT, serving = the reverse.
   *  A moved gate (a barrier retired the lifecycle) makes the pinned write LOSE — THROW; this is
   *  the lifecycle fence. The rows are indexed under each lifecycle (a later-winning barrier
   *  enumerates and revokes them), but confer NOTHING and release NO usable bytes until finalize. */
  stagePair(grant: SessionGrant, ids: SessionCredentialIds): MaybePromise<void>;
  /** After finalize → `active`, release ONE party's usable credential by id. Per-party sinks:
   *  the holder receives ONLY its own credential in the redemption response; the serving
   *  instance retrieves ONLY its own via a serving-authenticated one-use path ({@link
   *  retrieveServingCredential}). No private material crosses between the two parties. */
  releaseCredential(sessionId: string, credentialId: string): MaybePromise<SessionCredential>;
  /** Revoke one staged/released credential by id (eviction rides the auth path's machinery). */
  revokeCredential(id: string): MaybePromise<void>;
  now?(): number;
}

async function refuseAndCollect(
  hooks: SessionRedemptionHooks,
  sessionId: string,
  ids: SessionCredentialIds | undefined,
  to: SessionTerminalState,
  err: EpEnvelopeError,
): Promise<never> {
  // Best-effort containment before the refusal surfaces: the row (when ours) goes terminal and
  // both staged credentials are revoked by name. Failures here must not mask the refusal —
  // the expiry sweep is the durable backstop for exactly this window.
  try {
    await hooks.ledger.transitionTerminal(sessionId, to);
  } catch {
    /* sweep backstop */
  }
  if (ids) {
    for (const id of [ids.credCaller, ids.credServing]) {
      try {
        await hooks.revokeCredential(id);
      } catch {
        /* sweep backstop */
      }
    }
  }
  throw err;
}

/**
 * Redeem a VERIFIED session grant (§13.6 finalize-CAS ordering). The panel-locked order — no
 * half-issued session is ever usable, a redemption racing a close loses its finalize and
 * releases nothing:
 *
 *   1. allocate both credential ids (no bytes);
 *   2. create-CAS the `issuing` row naming BOTH ids (the one-use — a duplicate loses here);
 *   3. stage both credential rows GATE-PINNED to each lifecycle issuance gate (the lifecycle
 *      FENCE: a retired lifecycle makes the pinned write lose);
 *   4. fresh-check both process epochs (leader-served reads, bounded by epoch-in-subject death);
 *   5. finalize-CAS `issuing → active` (a racing close/barrier wins here);
 *   6. release ONLY the HOLDER's credential (the serving side retrieves its own separately).
 *
 * The caller passes the output of {@link verifySessionGrant} (signature/anchor/currency already
 * enforced there). Returns the HOLDER's credential alone — {@link retrieveServingCredential}
 * delivers the serving side's, so no private material crosses between the two parties.
 */
export async function redeemSession(grant: SessionGrant, hooks: SessionRedemptionHooks): Promise<SessionCredential> {
  const now = hooks.now?.() ?? Date.now();
  if (now > grant.exp) throw new EpEnvelopeError("expired", `session grant expired at ${grant.exp} (now ${now})`);

  // Cheap fail-fast currency (authoritative re-check happens at the finalize below — these
  // only avoid burning the one-use and staging for an already-dead pair).
  const preHolder = await hooks.holderProcessEpoch(grant.holder);
  if (preHolder !== grant.holder.processEpoch)
    throw new EpEnvelopeError("expired", `holder process epoch ${String(preHolder)} is not the grant's ${grant.holder.processEpoch}; an unredeemed grant does not survive the caller's restart (SPEC 13.1/13.6)`);
  const preServing = await hooks.servingEpoch(grant.endpoint, grant.serving.instanceId);
  if (preServing !== grant.serving.epoch)
    throw new EpEnvelopeError("expired", `serving epoch ${String(preServing)} is not the grant's ${grant.serving.epoch}; the session dies with the serving instance's epoch (SPEC 13.6)`);

  // (1) Allocate both ids FIRST so the issuing row names both from its very first write — a crash
  // after the create leaves a row that names exactly what the sweep revokes.
  const ids = await hooks.allocateCredentialIds(grant);

  // (2) The one-use: create-CAS the issuing row.
  const row: SessionLedgerRow = {
    sessionId: grant.sessionId,
    serving: grant.serving,
    holder: { principal: grant.holder.id, lifecycleUid: grant.holder.lifecycleUid },
    credCaller: ids.credCaller,
    credServing: ids.credServing,
    state: "issuing",
    exp: grant.exp,
  };
  const created = await hooks.ledger.createIssuing(row);
  if (created === "exists")
    throw new EpEnvelopeError("permission-denied", `session ${grant.sessionId} is already redeemed; the issuing create-CAS is the one-use (SPEC 13.6)`);

  // (3) The LIFECYCLE FENCE: stage both credential rows gate-pinned. A moved gate throws — a
  // retired holder/serving lifecycle cannot mint a live half.
  try {
    await hooks.stagePair(grant, ids);
  } catch (e) {
    return refuseAndCollect(hooks, grant.sessionId, ids, "retired", e instanceof EpEnvelopeError ? e : new EpEnvelopeError("permission-denied", `session ${grant.sessionId} credential staging lost the lifecycle gate (a barrier retired a party during redemption, SPEC 13.1/13.6): ${(e as Error)?.message ?? String(e)}`));
  }

  // (4) FINALIZE fresh checks (leader-served epoch reads; the lifecycle gates were fenced by the
  // gate-pinned stage above, and a barrier that wins AFTER the stage finds both rows indexed).
  const holderEpoch = await hooks.holderProcessEpoch(grant.holder);
  if (holderEpoch !== grant.holder.processEpoch)
    return refuseAndCollect(hooks, grant.sessionId, ids, "retired", new EpEnvelopeError("expired", `holder process epoch moved to ${String(holderEpoch)} during redemption; finalize fresh-checks the holder (SPEC 13.6)`));
  const servingNow = await hooks.servingEpoch(grant.endpoint, grant.serving.instanceId);
  if (servingNow !== grant.serving.epoch)
    return refuseAndCollect(hooks, grant.sessionId, ids, "superseded", new EpEnvelopeError("expired", `serving epoch moved to ${String(servingNow)} during redemption; finalize fresh-checks the serving instance (SPEC 13.6)`));

  // (5) The finalize CAS — a racing close/barrier wins here.
  const finalized = await hooks.ledger.finalizeActive(grant.sessionId);
  if (!finalized) {
    for (const id of [ids.credCaller, ids.credServing]) {
      try {
        await hooks.revokeCredential(id);
      } catch {
        /* sweep backstop */
      }
    }
    throw new EpEnvelopeError("conflict", `session ${grant.sessionId} finalize lost: the row left "issuing" during redemption (a racing close wins; nothing is released, SPEC 13.6)`);
  }

  // (6) Release ONLY the holder's credential (the serving side retrieves its own separately).
  return hooks.releaseCredential(grant.sessionId, ids.credCaller);
}

/** The serving instance retrieves ITS OWN credential after the session is `active`, through its
 *  own authenticated path (never the holder's redemption response — no private material crosses
 *  between the two parties, §13.6 per-party release). Refuses unless the row names this serving
 *  credential and is `active`. */
export async function retrieveServingCredential(
  sessionId: string,
  row: Pick<SessionLedgerRow, "state" | "credServing">,
  hooks: Pick<SessionRedemptionHooks, "releaseCredential">,
): Promise<SessionCredential> {
  if (row.state !== "active")
    throw new EpEnvelopeError("failed-precondition", `session ${sessionId} is "${row.state}", not active; a credential is authority only once its row is active (SPEC 13.6)`);
  return hooks.releaseCredential(sessionId, row.credServing);
}

/** The expiry sweep's per-row decision (the auth path enumerates `session.>` and calls this):
 *  an `issuing` or `active` row past its `exp` (plus the caller's margin) transitions
 *  `expired` and BOTH credential ids are revoked by name — a crashed half-issue can never
 *  leave a live half-pair. Returns whether this row was collected. Terminal rows are never
 *  touched (retention: rows live at least max session exp + a recovery margin, §13.6). */
export async function sweepSessionRow(
  row: SessionLedgerRow,
  hooks: Pick<SessionRedemptionHooks, "ledger" | "revokeCredential">,
  opts: { now: number; marginMs?: number },
): Promise<boolean> {
  if ((SESSION_TERMINAL_STATES as readonly string[]).includes(row.state)) return false;
  if (opts.now <= row.exp + (opts.marginMs ?? 0)) return false;
  const moved = await hooks.ledger.transitionTerminal(row.sessionId, "expired");
  if (!moved) return false; // someone else already terminated it (they revoke)
  for (const id of [row.credCaller, row.credServing]) {
    try {
      await hooks.revokeCredential(id);
    } catch {
      /* the next sweep pass retries: the row is terminal, ids are recorded */
    }
  }
  return true;
}

// ---- the rails: framed protocol + bounded credit window --------------------------------------

/** The composite's own tiny framed protocol; `data` is OPAQUE (any JSON value — binary rides
 *  the application's own encoding). `credit`/`close` are CONTROL frames, EXEMPT from the data
 *  window (a full data window must never block the credits that reopen it, else instant
 *  deadlock). `ack` is an ABSOLUTE cumulative watermark (the sender's contiguous-received count
 *  on the OTHER rail): a data frame PIGGYBACKS it, so a lost dedicated credit self-heals on the
 *  next reverse data frame, and a lost pair recovers on the receiver's idle re-emit; absolute
 *  (not delta) so any single credit re-advertises the whole position. The in-band `close` is
 *  advisory (§13.6): revocation authority is the ledger, never this frame. */
export type SessionFrame =
  | { t: "f"; seq: number; data: unknown; ack?: number }
  | { t: "credit"; ack: number }
  | { t: "close" };

export function encodeSessionFrame(frame: SessionFrame): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(frame));
}

/** Fail-loud frame parse (closed schema): a garbled frame is a PROTOCOL error the rail
 *  surfaces via `onProtocolError` — never silently skipped, never a crash. */
export function parseSessionFrame(bytes: Uint8Array): SessionFrame {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    invalid("session frame is not UTF-8 JSON");
  }
  if (!isRec(raw)) invalid("session frame is not an object");
  const o = raw as Record<string, unknown>;
  if (o.t === "f") {
    for (const k of Object.keys(o)) if (k !== "t" && k !== "seq" && k !== "data" && k !== "ack") invalid(`data frame carries unknown field "${k}"`);
    if (typeof o.seq !== "number" || !Number.isSafeInteger(o.seq) || o.seq < 1) invalid("data frame seq is not a positive integer");
    if (!("data" in o)) invalid("data frame carries no data");
    if (o.ack !== undefined && (typeof o.ack !== "number" || !Number.isSafeInteger(o.ack) || o.ack < 0)) invalid("data frame ack is not a non-negative integer");
    return { t: "f", seq: o.seq, data: o.data, ...(o.ack !== undefined ? { ack: o.ack } : {}) };
  }
  if (o.t === "credit") {
    for (const k of Object.keys(o)) if (k !== "t" && k !== "ack") invalid(`credit frame carries unknown field "${k}"`);
    if (typeof o.ack !== "number" || !Number.isSafeInteger(o.ack) || o.ack < 0) invalid("credit frame ack is not a non-negative integer");
    return { t: "credit", ack: o.ack };
  }
  if (o.t === "close") {
    for (const k of Object.keys(o)) if (k !== "t") invalid(`close frame carries unknown field "${k}"`);
    return { t: "close" };
  }
  invalid(`unknown session frame type ${String((o as { t?: unknown }).t)}`);
}

/** Which rail each role sends on (§13.6: `in` = caller → endpoint; `out` = the reverse). */
export type SessionRole = "caller" | "serving";

export interface SessionRailOpts {
  nc: NatsConnection;
  grant: Pick<SessionGrant, "space" | "endpoint" | "sessionId" | "window"> & { serving: { epoch: number } };
  role: SessionRole;
  /** Delivered in-order for CONTIGUOUS frames; a gap surfaces via onProtocolError("gap"). */
  onData(data: unknown, seq: number): void;
  /** The peer's advisory close frame arrived (authoritative close is the ledger's). */
  onClose?(): void;
  /** A garbled frame, a sequence gap, or a send stall: the session is broken — close and
   *  re-establish. `reason` is one of `garbled-frame` | `gap` | `credit-overrun` |
   *  `subscription` | `stall`. */
  onProtocolError?(reason: string, detail?: unknown): void;
  /** Broker payload ceiling for the SEND preflight (like assertFactFits). Default 1 MiB. */
  maxPayloadBytes?: number;
  /** Idle credit re-emit interval (ms): while this side has delivered data past what it last
   *  credited AND the peer has gone quiet (a possible double-credit-loss stall), re-advertise
   *  the absolute watermark so the blocked peer recovers. 0 disables. Default 1000. */
  idleCreditMs?: number;
  /** Sender stall watchdog (ms): if the data window stays full this long with NO credit advance
   *  (both the dedicated credit AND its idle re-emits were lost under sustained loss), the next
   *  send surfaces a DETECTABLE `stall` fault instead of hanging silently. Default 30000. */
  stallTimeoutMs?: number;
  /** Injectable clock (testability); default Date.now. */
  now?: () => number;
  /** Injectable interval timer (testability); defaults to Node setInterval/clearInterval. */
  setIntervalFn?: (fn: () => void, ms: number) => { unref?: () => void };
  clearIntervalFn?: (h: unknown) => void;
}

export interface SessionRail {
  /** Send one opaque data frame (piggybacking this side's absolute reverse-rail watermark).
   *  Throws `resource-exhausted` when the window is full (no buffering, §13.6), `contract-invalid`
   *  when the encoded frame exceeds the payload ceiling, and `failed-precondition` once the rail
   *  is closed/broken (including a detected stall). Returns the frame's seq. */
  send(data: unknown): number;
  /** Send the advisory close frame and stop the rail locally. Idempotent. */
  close(): void;
  /** In-memory window state (observability + smoke assertions). */
  stats(): { sent: number; ackedThrough: number; delivered: number; inFlight: number };
}

/**
 * Open one side of an established session over its two core rails. The credentials the
 * redemption released confine each side to exactly its pub/sub pair; this helper only speaks
 * the framed protocol and enforces the bounded window — it grants nothing.
 *
 * FLOW CONTROL (panel-locked): the data window is bounded and per-direction; control frames
 * (`credit`, `close`) are EXEMPT (a full window never blocks the credits that reopen it).
 * Credits carry an ABSOLUTE cumulative watermark, PIGGYBACKED on reverse data frames, so a lost
 * dedicated credit self-heals on the next reverse traffic; a lost PAIR recovers on the idle
 * re-emit; sustained loss surfaces a detectable `stall` fault (never a silent hang). A dropped
 * DATA frame is unrecoverable at this transport (EPS is at-most-once, core-only) and shows as a
 * seq gap the app reacts to — reliability layers inside `data` or uses the journal/checkpoint
 * composites.
 */
export function openSessionRail(opts: SessionRailOpts): SessionRail {
  const { grant, role } = opts;
  const window = assertWindow(grant.window);
  const maxPayload = opts.maxPayloadBytes ?? 1024 * 1024;
  const idleCreditMs = opts.idleCreditMs ?? 1000;
  const stallTimeoutMs = opts.stallTimeoutMs ?? 30_000;
  const now = opts.now ?? (() => Date.now());
  const setIntervalFn = opts.setIntervalFn ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const clearIntervalFn = opts.clearIntervalFn ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>));
  const egressDir: EpSessionDir = role === "caller" ? "in" : "out";
  const ingressDir: EpSessionDir = role === "caller" ? "out" : "in";
  const egress = epsSubject(grant.space, grant.endpoint, grant.sessionId, grant.serving.epoch, egressDir);
  const ingress = epsSubject(grant.space, grant.endpoint, grant.sessionId, grant.serving.epoch, ingressDir);

  let seq = 0; // last sent
  let ackedThrough = 0; // peer's contiguous ack for OUR egress (absolute)
  let windowFullSince = 0; // when the window first blocked with no ack advance (0 = not blocked)
  let expected = 1; // next ingress data seq we can deliver contiguously
  let deliveredSinceCredit = 0;
  let lastEmittedAck = 0; // highest absolute ack we have advertised (dedicated or piggybacked)
  let dataSinceIdleTick = false; // did ingress data arrive since the last idle tick?
  let delivered = 0;
  let closed = false;
  let broken = false;
  const creditEvery = Math.max(1, Math.ceil(window / 2));

  const protocolError = (reason: string, detail?: unknown) => {
    broken = true;
    opts.onProtocolError?.(reason, detail);
  };
  // Absorb an absolute watermark from a credit frame OR a piggybacked data ack. Monotonic — a
  // stale/duplicated advertisement never narrows the window; an ack past what we ever sent is a
  // protocol violation (fail-loud, never silently widen).
  const applyAck = (ack: number): void => {
    if (ack > seq) {
      protocolError("credit-overrun", { ack, sent: seq });
      return;
    }
    if (ack > ackedThrough) {
      ackedThrough = ack;
      windowFullSince = 0; // progress — reset the stall watchdog
    }
  };
  const emitCredit = (): void => {
    const ack = expected - 1;
    lastEmittedAck = ack;
    opts.nc.publish(egress, encodeSessionFrame({ t: "credit", ack }));
  };

  const sub: Subscription = opts.nc.subscribe(ingress, {
    callback: (err, msg) => {
      if (closed || broken) return;
      if (err) {
        protocolError("subscription", err.message);
        return;
      }
      let frame: SessionFrame;
      try {
        frame = parseSessionFrame(msg.data);
      } catch (e) {
        protocolError("garbled-frame", (e as Error).message);
        return;
      }
      if (frame.t === "credit") {
        applyAck(frame.ack);
        return;
      }
      if (frame.t === "close") {
        closed = true;
        opts.onClose?.();
        return;
      }
      // Data. Its piggybacked ack refreshes OUR credit first (self-heals a lost dedicated
      // credit), then contiguity governs delivery (§13.6: a dropped frame is the composite's
      // problem): a duplicate drops, a GAP breaks the session loudly.
      if (frame.ack !== undefined) applyAck(frame.ack);
      dataSinceIdleTick = true;
      if (frame.seq < expected) return; // duplicate — idempotent drop
      if (frame.seq > expected) {
        protocolError("gap", { expected, got: frame.seq });
        return;
      }
      expected++;
      delivered++;
      deliveredSinceCredit++;
      opts.onData(frame.data, frame.seq);
      if (deliveredSinceCredit >= creditEvery) {
        deliveredSinceCredit = 0;
        emitCredit();
      }
    },
  });

  // Idle re-emit: while we hold ungranted delivery (delivered past our last advertised ack) and
  // the peer has gone quiet (no ingress data this tick — the tell of a sender blocked on a full
  // window whose credits were lost), re-advertise the absolute watermark. Non-spammy: it fires
  // only on the quiet-with-ungranted-delivery condition, at most once per interval.
  const idleTimer = idleCreditMs > 0
    ? setIntervalFn(() => {
        if (closed || broken) return;
        if (!dataSinceIdleTick && expected - 1 > lastEmittedAck) emitCredit();
        dataSinceIdleTick = false;
      }, idleCreditMs)
    : undefined;
  idleTimer?.unref?.();

  const stopTimers = () => { if (idleTimer) clearIntervalFn(idleTimer); };

  return {
    send(data: unknown): number {
      if (closed || broken)
        throw new EpEnvelopeError("failed-precondition", "session rail is closed/broken; establish a new session (SPEC 13.6)");
      if (seq - ackedThrough >= window) {
        // The window is full. Distinguish a TRANSIENT stall (retry when credit lands) from a
        // sustained one (both credit and its idle re-emits lost): after stallTimeoutMs with no
        // ack advance, break the rail with a DETECTABLE fault instead of hanging forever.
        const t = now();
        if (windowFullSince === 0) windowFullSince = t;
        else if (t - windowFullSince > stallTimeoutMs) {
          protocolError("stall", { window, ackedThrough, sent: seq, blockedMs: t - windowFullSince });
          stopTimers();
          throw new EpEnvelopeError("failed-precondition", `session rail stalled: the window stayed full ${t - windowFullSince}ms with no credit; the peer is unreachable, re-establish (SPEC 13.6)`);
        }
        throw new EpEnvelopeError(
          "resource-exhausted",
          `session window is full (${window} unacknowledged frames); the flow window is bounded and nothing buffers (SPEC 13.6)`,
        );
      }
      // Piggyback our absolute reverse-rail watermark so a lost dedicated credit self-heals.
      const ack = expected - 1;
      const frame = encodeSessionFrame({ t: "f", seq: seq + 1, data, ...(ack > 0 ? { ack } : {}) });
      if (frame.byteLength > maxPayload)
        throw new EpEnvelopeError("contract-invalid", `session frame is ${frame.byteLength} bytes, over the ${maxPayload}-byte payload ceiling`);
      seq++;
      if (ack > lastEmittedAck) lastEmittedAck = ack;
      opts.nc.publish(egress, frame);
      return seq;
    },
    close(): void {
      if (closed) return;
      closed = true;
      stopTimers();
      try {
        opts.nc.publish(egress, encodeSessionFrame({ t: "close" }));
      } catch {
        /* advisory only — the ledger is the authority */
      }
      sub.unsubscribe();
    },
    stats() {
      return { sent: seq, ackedThrough, delivered, inFlight: seq - ackedThrough };
    },
  };
}
