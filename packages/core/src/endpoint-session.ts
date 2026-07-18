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
 *    `{sessionId, endpoint, serving, holder, both credential ids, per-credential revocation
 *    marks, state, exp}` with the monotonic state grammar
 *    `issuing → active → closed|expired|superseded|retired` (all terminal). The create-CAS of
 *    the `issuing` row IS the one-use redemption; the finalize-CAS `issuing → active`
 *    fresh-checks BOTH process epochs and both lifecycle gates and releases the two
 *    credentials only on success. A credential is authority ONLY once its row is `active`; an
 *    `issuing` row confers nothing (the auth path's connect boundary enforces that; this
 *    module pins the contract and the ordering). A crash mid-issue leaves an `issuing` row the
 *    expiry sweep collects (revoking BOTH ids by name and tombstoning), never a live
 *    half-pair; a redemption racing a close loses its finalize and releases nothing. The
 *    revocation marks make the sweep's retry REAL: a revoke that failed leaves its mark
 *    unset, and every later sweep pass retries exactly the unmarked halves until both confirm.
 *  - the REDEMPTION SEAM ({@link redeemSession}): core owns the ordering, the refusal catalog,
 *    and the AUTHORITY EDGES — the redemption is presented by an AUTHENTICATED presenter that
 *    must equal the grant's holder exactly (a leaked grant alone releases nothing; §13.10
 *    holder-binding is enforced here, not assumed), and the lifecycle fence is the
 *    REVISION-PINNED {@link SessionRedemptionHooks.stagePair} write against both parties'
 *    OBSERVED issuance gates (a moved gate makes the pinned write LOSE; a read is never a
 *    fence, §13.1/§13.9). The trusted auth path (§9/§10, off-broker) wires the real KV
 *    create/finalize CAS, the credential mint, and revocation — the same seam pattern as D4's
 *    issuance gate.
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
 *    Credit-loss recovery is three-legged: PIGGYBACKED absolute acks on reverse data, the
 *    KEEPALIVE re-emit (a quiet peer gets the absolute watermark re-advertised every idle
 *    tick — deliberately including watermarks already advertised, because the receiver cannot
 *    observe whether an emitted credit arrived), and the TIMER-DRIVEN stall watchdog (a full
 *    window with no ack advance breaks the rail with a detectable fault even if the sender
 *    never calls send again).
 *  - CLOSE: the in-band `{t:"close"}` frame is an ADVISORY peer signal, never the revocation
 *    authority (EPS subjects are captured by nothing) — but it DOES tear down the receiving
 *    side's local subscription and timer exactly once (a remote close must never leak local
 *    resources). Authoritative close/expiry live on the trusted auth path: an authenticated
 *    close op (a session party or the operator names the sessionId; party membership is
 *    verified against the ledger row), the auth path's own expiry timer, or either side's
 *    §13.1 barrier — each transitions the row terminal and revokes BOTH credentials, so
 *    neither side can keep a half-closed session alive and a crashed serving endpoint cannot
 *    orphan one (the ledger, not the endpoint, remembers what to revoke).
 */
import { randomBytes } from "node:crypto";
import type { NatsConnection, Subscription } from "@nats-io/transport-node";
import { EpEnvelopeError } from "./endpoint-envelope.js";
import { canonicalJson } from "./canonical.js";
import { parsePrincipalKey, assertValidOwnerToken } from "./subjects.js";
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
  assertArtifactCurrency,
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
/** §13.6 "fresh unguessable sessionId": at least 22 base64url chars (≥128 bits) — enforced on
 *  CALLER-SUPPLIED ids too, so a short guessable id cannot ride in through the mint arg. */
export const SESSION_ID_MIN_CHARS = 22;

/** Mint a fresh unguessable sessionId: 32 CSPRNG bytes, base64url (43 chars, within the
 *  bounded id-token grammar the subject builder pins). */
export function mintSessionId(): string {
  return assertSessionId(randomBytes(32).toString("base64url"));
}

function assertSessionId(v: unknown): string {
  const id = assertIdToken(v as string, "sessionId");
  if (id.length < SESSION_ID_MIN_CHARS)
    invalid(`sessionId is ${id.length} chars, under the ${SESSION_ID_MIN_CHARS}-char unguessability floor`);
  return id;
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

/** `holder.id` is a PRINCIPAL, not a free-form string: the dot-form `<owner>.<actor>`
 *  (user-mode) or a bare static/dev actor token (dot-free) — the same grammar the §13.1
 *  deprovision target pins. A free-form holder would name a party no authority layer can
 *  attribute, so the presenter-equality check downstream would compare garbage to garbage. */
function assertHolderId(id: unknown): string {
  if (typeof id !== "string" || id.length === 0 || id.length > 256) invalid("holder.id is not a bounded principal string");
  if (parsePrincipalKey(id)) return id;
  try {
    return assertValidOwnerToken(id);
  } catch {
    invalid(`holder.id "${id}" is neither a principal dot-form (<owner>.<actor>) nor a bare static actor token`);
  }
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
  const sessionId = args.sessionId !== undefined ? assertSessionId(args.sessionId) : mintSessionId();
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
 *  re-derived and compared; currency is checked at `now`. Fail-closed everywhere; every nested
 *  object is a CLOSED schema. */
export async function verifySessionGrant(
  raw: unknown,
  opts: { space: string; resolveAnchor: AnchorResolver; now?: number },
): Promise<SessionGrant> {
  const now = opts.now ?? Date.now();
  // The clock authority is validated at ENTRY, before any anchor or signature work (the same
  // rule verifyHandleChain pins): every currency rule is a numeric comparison, so a
  // NaN/fractional/negative clock would make them all silently false and a stale or
  // forward-dated grant would VERIFY. The shared helper re-checks as a belt.
  if (!Number.isSafeInteger(now) || now < 0)
    throw new EpEnvelopeError("failed-precondition", `now must be a non-negative safe integer; got ${JSON.stringify(now)} (an invalid clock authority never verifies, SPEC 13.10)`);
  if (!isRec(raw)) invalid("a session grant is not an object");
  // Byte bound BEFORE any structural walk (a canonicalization failure is contract-invalid too:
  // an artifact that cannot canonicalize cannot have been signed). UTF-8 BYTES, not JS chars —
  // a multibyte payload must not slide under the bound on character count.
  let canonical: string;
  try {
    const { sig: _sig, ...rest } = raw as Record<string, unknown>;
    canonical = canonicalJson(rest);
  } catch (e) {
    invalid(`session grant does not canonicalize: ${(e as Error)?.message ?? String(e)}`);
  }
  if (Buffer.byteLength(canonical, "utf8") > SESSION_GRANT_MAX_BYTES) invalid(`session grant exceeds ${SESSION_GRANT_MAX_BYTES} bytes`);

  const o = raw as Record<string, unknown>;
  const allowed = new Set(["v", "sessionId", "space", "endpoint", "subjects", "holder", "serving", "window", "iat", "nbf", "exp", "nonce", "issuer", "sig"]);
  for (const k of Object.keys(o)) if (!allowed.has(k)) invalid(`session grant carries the unknown field "${k}" (closed schema)`);
  if (o.v !== 1) invalid(`unknown session grant version ${String(o.v)}`);
  if (typeof o.space !== "string" || o.space.length === 0) invalid("space is not a string");
  if (o.space !== opts.space) throw new EpEnvelopeError("permission-denied", `session grant is for space "${o.space}", not "${opts.space}" (audience, SPEC 13.6)`);
  const sessionId = assertSessionId(o.sessionId);
  const endpoint = endpointToken(o.endpoint as string);
  if (!isRec(o.serving)) invalid("serving is not an object");
  const sv = o.serving as Record<string, unknown>;
  for (const k of Object.keys(sv)) if (k !== "instanceId" && k !== "epoch") invalid(`serving carries the unknown field "${k}" (closed schema)`);
  const serving = {
    instanceId: assertLifecycleToken(sv.instanceId as string, "serving.instanceId"),
    epoch: assertEpochInt(sv.epoch, "serving.epoch"),
  };
  if (!isRec(o.holder)) invalid("holder is not an object");
  const h = o.holder as Record<string, unknown>;
  for (const k of Object.keys(h)) if (k !== "id" && k !== "lifecycleUid" && k !== "processEpoch") invalid(`holder carries the unknown field "${k}" (closed schema)`);
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
  if (typeof o.nonce !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(o.nonce)) invalid("nonce is not a bounded base64url token");
  if (!isRec(o.issuer)) invalid("issuer is not an object");
  const iss = o.issuer as Record<string, unknown>;
  for (const k of Object.keys(iss)) if (k !== "keyId") invalid(`issuer carries the unknown field "${k}" (closed schema)`);
  if (typeof iss.keyId !== "string") invalid("issuer.keyId is not a string");

  // Anchor gate: fresh resolution, role, window-at-signing, revocation-at-verification, and
  // the sessions scope ceiling covers THIS endpoint (an absent dimension is closed).
  const anchor = await resolveAnchorForUse(opts.resolveAnchor, { keyId: iss.keyId, role: "sessions", at: o.iat });
  assertAnchorScopeCovers(anchor, "sessions", endpoint, "the session's endpoint");
  verifyArtifactSignature(o, anchor);

  // Currency LAST (after identity): a forged-but-expired artifact is permission-denied above,
  // never a soft "expired" that leaks verification order. The rules are the SHARED
  // assertArtifactCurrency (SPEC 1778: session expiry follows the handle rules — enforced by
  // calling the same primitive verifyHandleChain calls, not a hand copy that can drift);
  // "post-signature" because identity is established, so the soft codes are safe here.
  assertArtifactCurrency(
    { iat: o.iat as number, ...(o.nbf !== undefined ? { nbf: o.nbf as number } : {}), exp: o.exp as number },
    { now, ceilingMs: SESSION_GRANT_MAX_TTL_MS, what: "session grant", ceilingName: "live", refusals: "post-signature" },
  );

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
    issuer: { keyId: iss.keyId },
    sig: o.sig as string,
  };
}

// ---- the session ledger row (auth store `session.<sessionId>`, §13.12) -----------------------

// Runtime-frozen + a private Set the transition/sweep seams consult (the afa715b class: a
// spliced-out "closed" would otherwise disable the revocation-retry backstop, executed repro).
export const SESSION_TERMINAL_STATES = Object.freeze(["closed", "expired", "superseded", "retired"] as const);
const TERMINAL_STATE_SNAP: ReadonlySet<string> = new Set(SESSION_TERMINAL_STATES);
export type SessionTerminalState = (typeof SESSION_TERMINAL_STATES)[number];
export type SessionState = "issuing" | "active" | SessionTerminalState;

/** The durable revocation authority that survives the serving endpoint (§13.6). Both
 *  credential ids are recorded FROM CREATION (the `issuing` write), so a crash at any later
 *  point leaves a row that names exactly what the sweep must revoke. The row also pins the
 *  ENDPOINT: `instanceId` is unique only within `(space, endpoint)`, so a row without the
 *  endpoint could not prove WHICH endpoint's serving party is entitled to retrieve/close. */
export interface SessionLedgerRow {
  sessionId: string;
  /** The serving endpoint name — with `serving.instanceId`/`epoch` this is the full serving
   *  identity every serving-party operation authenticates against. */
  endpoint: string;
  serving: { instanceId: string; epoch: number };
  holder: { principal: string; lifecycleUid: string };
  /** The WINNING grant's Ed25519 signature — the full verified-artifact identity (it covers
   *  window, holder processEpoch, iat/nbf, nonce, issuer, everything signed). The lost-response
   *  retry re-releases ONLY when the presenting grant's signature equals this, so a DIFFERENT
   *  signed grant that merely reuses the sessionId + the compared coordinate subset can never
   *  re-release the winner's credential (§13.6/§13.10). */
  grantSig: string;
  credCaller: string;
  credServing: string;
  /** Per-credential revocation completion (durable), created all-false: set only when that
   *  id's revoke SUCCEEDED, so a swallowed revoke failure anywhere is retried by every later
   *  sweep pass instead of silently leaking half a pair. */
  revoked: { caller: boolean; serving: boolean };
  state: SessionState;
  exp: number;
}

/** The auth-store key (`session.<sessionId>`, §13.12). */
export function sessionLedgerKey(sessionId: string): string {
  return `session.${assertSessionId(sessionId)}`;
}

/** The monotonic state grammar: `issuing → active`, `issuing → terminal` (the sweep collecting
 *  a crashed half-issue), `active → terminal`. Terminal states never transition. */
export function assertSessionStateTransition(from: SessionState, to: SessionState): void {
  const terminal = TERMINAL_STATE_SNAP.has(from);
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
  /** AUTHORITATIVE row read (leader-served, the §13.9 read-service class): the serving
   *  retrieval and the holder's post-finalize retry decide on THIS, never on a caller-supplied
   *  projection. `undefined` = no row. */
  read(sessionId: string): MaybePromise<SessionLedgerRow | undefined>;
  /** Create-only CAS of the `issuing` row (naming BOTH credential ids). `"exists"` = the
   *  one-use is already burned. */
  createIssuing(row: SessionLedgerRow): MaybePromise<"created" | "exists">;
  /** CAS `issuing → active`. `false` = the row moved under us (a close/sweep/barrier raced the
   *  finalize; the redemption LOSES and releases nothing). */
  finalizeActive(sessionId: string): MaybePromise<boolean>;
  /** CAS the row to a terminal state (close/expiry/barrier/abandoned redemption). `false` =
   *  already terminal (idempotent for the caller's purposes). */
  transitionTerminal(sessionId: string, to: SessionTerminalState): MaybePromise<boolean>;
  /** Durably mark ONE credential id's revocation as COMPLETED. The sweep's terminal-row retry
   *  is real only because the row remembers which halves confirmed. */
  markRevoked(sessionId: string, credentialId: string): MaybePromise<void>;
}

/** The two per-session credential IDs (the credential-ledger ids revocation names). Allocated
 *  BEFORE the one-use `issuing` create, so the row names both from its first durable write and a
 *  crash at any later point leaves the sweep able to revoke the whole pair. */
export interface SessionCredentialIds {
  credCaller: string;
  credServing: string;
}

/** One released per-session credential: the id revocation names, the usable creds bytes, and
 *  the credential's OWN expiry — which MUST be ≤ the session row's `exp` (the seam validates
 *  and fails loud on a hook that mints past the session's life). A credential is authority
 *  ONLY once its session row is `active`; nothing releases usable bytes before finalize. */
export interface SessionCredential {
  id: string;
  creds: string;
  exp: number;
}

/** One OBSERVED lifecycle issuance gate (§13.1): the auth-store gate key plus its revision at
 *  the observation (a LEADER-SERVED read). The staged credential writes are PINNED to it — a
 *  barrier that moves the gate between the observation and the stage makes the pinned write
 *  LOSE. This is what makes the two-gate stage→commit ordering testable in core rather than an
 *  opaque promise: the pin is data, and an adversarial probe can move the gate under it. */
export interface LifecycleGatePin {
  key: string;
  revision: number;
}

/** The AUTHENTICATED presenter of a redemption — established by the trusted auth path's own
 *  connection/exchange (§9/§10), NEVER read from the grant. {@link redeemSession} refuses
 *  unless it equals the grant's holder exactly: possession of a leaked grant releases nothing. */
export interface SessionPresenter {
  id: string;
  lifecycleUid: string;
}

/**
 * Everything {@link redeemSession} needs from the trusted auth path. The LIFECYCLE FENCE is the
 * revision-pinned {@link stagePair} write against both parties' OBSERVED gates (a moved gate
 * makes it LOSE), NOT a boolean read — fresh reads are not fences (§13.1/§13.9). The
 * process-epoch and gate reads ARE fencing/observation reads and MUST be leader-served (the
 * auth bucket `allow_direct=false` → `STREAM.MSG.GET`, per the §13.9 read-service class),
 * never a follower Direct Get. Every hook re-runs FRESH at finalize; a cached answer would
 * reopen the §13.1 window.
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
  /** LEADER-SERVED observation of the HOLDER's lifecycle issuance gate (§13.1). Throws when
   *  the gate is gone (the lifecycle is retired). */
  observeHolderGate(holder: { id: string; lifecycleUid: string }): MaybePromise<LifecycleGatePin>;
  /** LEADER-SERVED observation of the SERVING instance's lifecycle issuance gate. */
  observeServingGate(endpoint: string, instanceId: string): MaybePromise<LifecycleGatePin>;
  /** Stage BOTH per-session credential-ledger rows, each write REVISION-PINNED to its party's
   *  observed gate (§13.1): caller = pub `in` + sub `out` EXACT, serving = the reverse. A gate
   *  that moved since its observation (a barrier retired the lifecycle) makes the pinned write
   *  LOSE — THROW; this is the lifecycle fence, a write loss, never a boolean read. The rows
   *  are indexed under each lifecycle (a later-winning barrier enumerates and revokes them),
   *  but confer NOTHING and release NO usable bytes until finalize. */
  stagePair(grant: SessionGrant, ids: SessionCredentialIds, pins: { holder: LifecycleGatePin; serving: LifecycleGatePin }): MaybePromise<void>;
  /** After finalize → `active`, release ONE party's usable credential by id. IDEMPOTENT for
   *  the row's lifetime: a repeated release of the same id returns the SAME credential bytes
   *  (never a re-mint) — that is the authenticated lost-response retry path for BOTH parties.
   *  Safe because every release sits behind exact presenter authentication (holder equality at
   *  {@link redeemSession}; full serving identity at {@link retrieveServingCredential}), so a
   *  repeat delivers no authority the party does not already hold; revocation (a terminal row)
   *  is the authority boundary, not a release count. Per-party sinks: no private material ever
   *  crosses between the two parties. */
  releaseCredential(sessionId: string, credentialId: string): MaybePromise<SessionCredential>;
  /** Revoke one staged/released credential by id, IDEMPOTENTLY (re-revoking a dead id
   *  succeeds — the sweep's terminal-row retry depends on it). */
  revokeCredential(id: string): MaybePromise<void>;
  now?(): number;
}

/** Bounded credential-ledger id (no usable bytes ride in an id). */
function assertCredentialId(v: unknown, what: string): string {
  if (typeof v !== "string" || v.length === 0 || v.length > 256) invalid(`${what} is not a bounded credential id`);
  return v;
}

/** Fail-loud validation of what a release hook handed back: the requested id, within the
 *  session's life. A hook that returns someone else's credential or one outliving the session
 *  violated the seam contract — surface it, never pass it through. */
function assertReleased(cred: SessionCredential, wantId: string, sessionExp: number): SessionCredential {
  if (!isRec(cred) || cred.id !== wantId)
    invalid(`the release returned credential "${String((cred as { id?: unknown })?.id)}", not the requested "${wantId}" (hook contract)`);
  if (typeof cred.exp !== "number" || !Number.isSafeInteger(cred.exp) || cred.exp > sessionExp)
    invalid(`released credential exp ${String(cred.exp)} is not an integer within the session exp ${sessionExp} (a credential must not outlive its session)`);
  return cred;
}

async function refuseAndCollect(
  hooks: SessionRedemptionHooks,
  sessionId: string,
  ids: SessionCredentialIds | undefined,
  to: SessionTerminalState,
  err: EpEnvelopeError,
): Promise<never> {
  // Best-effort containment before the refusal surfaces: the row (when ours) goes terminal and
  // both staged credentials are revoked by name, each marked on success. Failures here must
  // not mask the refusal — the sweep's terminal-row retry (driven by the unmarked ids) is the
  // durable backstop for exactly this window.
  try {
    await hooks.ledger.transitionTerminal(sessionId, to);
  } catch {
    /* sweep backstop */
  }
  if (ids) {
    for (const id of [ids.credCaller, ids.credServing]) {
      try {
        await hooks.revokeCredential(id);
        await hooks.ledger.markRevoked(sessionId, id);
      } catch {
        /* the unmarked id is retried by the sweep */
      }
    }
  }
  throw err;
}

/**
 * Redeem a VERIFIED session grant (§13.6 finalize-CAS ordering), presented by an AUTHENTICATED
 * presenter. The panel-locked order — no half-issued session is ever usable, a redemption
 * racing a close loses its finalize and releases nothing:
 *
 *   0. the presenter must equal the grant's holder EXACTLY (identity before anything —
 *      possession of a leaked grant releases nothing, §13.10 holder-binding);
 *   1. allocate both credential ids (no bytes; bounded, distinct);
 *   2. create-CAS the `issuing` row naming BOTH ids (the one-use — a duplicate loses here,
 *      EXCEPT the authenticated holder retrying an active row after a lost response, which
 *      re-releases the SAME holder credential);
 *   3. observe both lifecycle issuance gates (leader-served) and stage both credential rows
 *      REVISION-PINNED to them (the lifecycle FENCE: a moved gate makes the pinned write lose);
 *   4. fresh-check both process epochs (leader-served reads) AND grant expiry;
 *   5. finalize-CAS `issuing → active` (a racing close/barrier wins here);
 *   6. release ONLY the HOLDER's credential (the serving side retrieves its own separately).
 *
 * The caller passes the output of {@link verifySessionGrant} (signature/anchor/currency already
 * enforced there) plus the presenter its OWN authenticated context established. Returns the
 * HOLDER's credential alone — {@link retrieveServingCredential} delivers the serving side's, so
 * no private material crosses between the two parties. A release failure AFTER finalize leaves
 * the row `active` and throws: the authenticated holder retries this same call and lands on the
 * re-release path (release is idempotent for the row's life), so a transient release outage is
 * recoverable without a half-session.
 */
export async function redeemSession(
  grant: SessionGrant,
  presenter: SessionPresenter,
  hooks: SessionRedemptionHooks,
): Promise<SessionCredential> {
  // (0) Identity first: the authenticated presenter IS the holder, exactly.
  if (typeof presenter?.id !== "string" || typeof presenter?.lifecycleUid !== "string")
    invalid("presenter is not an authenticated principal projection");
  if (presenter.id !== grant.holder.id || presenter.lifecycleUid !== grant.holder.lifecycleUid)
    throw new EpEnvelopeError("permission-denied", `session grant is holder-bound to ${grant.holder.id} (uid ${grant.holder.lifecycleUid}); the presenter is ${presenter.id} (uid ${presenter.lifecycleUid}); a grant is not a bearer artifact (SPEC 13.6/13.10)`);

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
  // after the create leaves a row that names exactly what the sweep revokes. Bounded + distinct:
  // aliased ids would collapse the two parties' revocation into one name.
  const ids = await hooks.allocateCredentialIds(grant);
  assertCredentialId(ids.credCaller, "credCaller");
  assertCredentialId(ids.credServing, "credServing");
  if (ids.credCaller === ids.credServing) invalid(`allocated credential ids alias ("${ids.credCaller}"); the two parties' ids must be distinct`);

  // (2) The one-use: create-CAS the issuing row.
  const row: SessionLedgerRow = {
    sessionId: grant.sessionId,
    endpoint: grant.endpoint,
    serving: grant.serving,
    holder: { principal: grant.holder.id, lifecycleUid: grant.holder.lifecycleUid },
    grantSig: grant.sig,
    credCaller: ids.credCaller,
    credServing: ids.credServing,
    revoked: { caller: false, serving: false },
    state: "issuing",
    exp: grant.exp,
  };
  const created = await hooks.ledger.createIssuing(row);
  if (created === "exists") {
    // The one-use is burned — with ONE authenticated exception: the holder whose redemption
    // response was lost AFTER finalize retries the same call, and release is idempotent for
    // the row's life (same bytes, no re-mint), so the retry re-releases the SAME credential.
    // The ids allocated above were never staged and carry no bytes — orphans by design.
    const existing = await hooks.ledger.read(grant.sessionId);
    // The retry re-releases ONLY for an EXACT replay of the grant that WON the one-use: the
    // presenter must be the holder AND the presenting grant's SIGNATURE must equal the winner's
    // (the signature is the full verified-artifact identity — window, holder processEpoch,
    // iat/nbf, nonce, issuer, everything signed — so a DIFFERENT signed grant reusing only the
    // sessionId + a coordinate subset can never re-release the winner's credential, even with a
    // larger flow window, SPEC 13.6/13.10).
    if (
      existing !== undefined &&
      existing.state === "active" &&
      existing.holder.principal === presenter.id &&
      existing.holder.lifecycleUid === presenter.lifecycleUid &&
      existing.grantSig === grant.sig
    ) {
      // Re-release the WINNER's stored credential id (never the freshly allocated `ids`, which
      // the create just lost): the ids allocated for this racing attempt carry no bytes.
      return assertReleased(await hooks.releaseCredential(grant.sessionId, existing.credCaller), existing.credCaller, existing.exp);
    }
    throw new EpEnvelopeError("permission-denied", `session ${grant.sessionId} is already redeemed; the issuing create-CAS is the one-use, and only an exact replay of the winning grant re-releases (SPEC 13.6)`);
  }

  // (3) The LIFECYCLE FENCE: observe both issuance gates (leader-served), then stage both
  // credential rows PINNED to those observations. A gate that moved — or is gone — means a
  // barrier retired a party: the pinned write LOSES and nothing was ever usable.
  try {
    const pins = {
      holder: await hooks.observeHolderGate(grant.holder),
      serving: await hooks.observeServingGate(grant.endpoint, grant.serving.instanceId),
    };
    await hooks.stagePair(grant, ids, pins);
  } catch (e) {
    return refuseAndCollect(hooks, grant.sessionId, ids, "retired", e instanceof EpEnvelopeError ? e : new EpEnvelopeError("permission-denied", `session ${grant.sessionId} credential staging lost the lifecycle gate (a barrier retired a party during redemption, SPEC 13.1/13.6): ${(e as Error)?.message ?? String(e)}`));
  }

  // (4) FINALIZE fresh checks: leader-served epoch reads (the lifecycle gates were fenced by
  // the pinned stage above, and a barrier that wins AFTER the stage finds both rows indexed),
  // plus expiry AT the finalize — a slow stage must not activate a grant that died meanwhile.
  const holderEpoch = await hooks.holderProcessEpoch(grant.holder);
  if (holderEpoch !== grant.holder.processEpoch)
    return refuseAndCollect(hooks, grant.sessionId, ids, "retired", new EpEnvelopeError("expired", `holder process epoch moved to ${String(holderEpoch)} during redemption; finalize fresh-checks the holder (SPEC 13.6)`));
  const servingNow = await hooks.servingEpoch(grant.endpoint, grant.serving.instanceId);
  if (servingNow !== grant.serving.epoch)
    return refuseAndCollect(hooks, grant.sessionId, ids, "superseded", new EpEnvelopeError("expired", `serving epoch moved to ${String(servingNow)} during redemption; finalize fresh-checks the serving instance (SPEC 13.6)`));
  const atFinalize = hooks.now?.() ?? Date.now();
  if (atFinalize > grant.exp)
    return refuseAndCollect(hooks, grant.sessionId, ids, "expired", new EpEnvelopeError("expired", `session grant expired at ${grant.exp} during redemption (now ${atFinalize}); finalize re-checks currency (SPEC 13.6)`));

  // (5) The finalize CAS — a racing close/barrier wins here.
  const finalized = await hooks.ledger.finalizeActive(grant.sessionId);
  if (!finalized) {
    for (const id of [ids.credCaller, ids.credServing]) {
      try {
        await hooks.revokeCredential(id);
        await hooks.ledger.markRevoked(grant.sessionId, id);
      } catch {
        /* sweep backstop (terminal-row retry) */
      }
    }
    throw new EpEnvelopeError("conflict", `session ${grant.sessionId} finalize lost: the row left "issuing" during redemption (a racing close wins; nothing is released, SPEC 13.6)`);
  }

  // (6) Release ONLY the holder's credential (the serving side retrieves its own separately).
  // A throw here leaves the row active: the authenticated holder retries and lands on the
  // re-release path above — recoverable, never a half-session.
  return assertReleased(await hooks.releaseCredential(grant.sessionId, ids.credCaller), ids.credCaller, grant.exp);
}

/** The serving instance retrieves ITS OWN credential after the session is `active`, through its
 *  own authenticated path (never the holder's redemption response — no private material crosses
 *  between the two parties, §13.6 per-party release). The presenter is the AUTHENTICATED serving
 *  identity (endpoint + instanceId + epoch, established by the auth path's own context); the row
 *  is read AUTHORITATIVELY from the ledger, never accepted as a caller-supplied projection.
 *  Release is idempotent for the row's life (lost-response retry), behind the exact identity. */
export async function retrieveServingCredential(
  sessionId: string,
  presenter: { endpoint: string; instanceId: string; epoch: number },
  hooks: Pick<SessionRedemptionHooks, "ledger" | "releaseCredential">,
): Promise<SessionCredential> {
  const row = await hooks.ledger.read(sessionId);
  if (row === undefined)
    throw new EpEnvelopeError("not-found", `session ${sessionId} has no ledger row (SPEC 13.6)`);
  if (row.endpoint !== presenter.endpoint || row.serving.instanceId !== presenter.instanceId || row.serving.epoch !== presenter.epoch)
    throw new EpEnvelopeError("permission-denied", `session ${sessionId} is pinned to serving ${row.endpoint}/${row.serving.instanceId}@${row.serving.epoch}, not the presenting ${presenter.endpoint}/${presenter.instanceId}@${presenter.epoch} (per-party release, SPEC 13.6)`);
  if (row.state !== "active")
    throw new EpEnvelopeError("failed-precondition", `session ${sessionId} is "${row.state}", not active; a credential is authority only once its row is active (SPEC 13.6)`);
  return assertReleased(await hooks.releaseCredential(sessionId, row.credServing), row.credServing, row.exp);
}

/** The expiry sweep's per-row decision (the auth path enumerates `session.>` and calls this):
 *  an `issuing` or `active` row past its `exp` (plus the caller's margin) transitions
 *  `expired` and BOTH credential ids are revoked by name, each MARKED on success. A TERMINAL
 *  row with an UNMARKED id is retried — that retry (not a comment) is what makes every
 *  swallowed revoke failure in this module safe: the mark is set only by a revoke that
 *  succeeded, so half a pair can never quietly outlive its session. Returns whether this pass
 *  did work. Fully-collected terminal rows are never touched (retention: rows live at least
 *  max session exp + a recovery margin, §13.6). */
export async function sweepSessionRow(
  row: SessionLedgerRow,
  hooks: Pick<SessionRedemptionHooks, "ledger" | "revokeCredential">,
  opts: { now: number; marginMs?: number },
): Promise<boolean> {
  const revokePending = async (): Promise<void> => {
    const pending: string[] = [];
    if (!row.revoked.caller) pending.push(row.credCaller);
    if (!row.revoked.serving) pending.push(row.credServing);
    for (const id of pending) {
      try {
        await hooks.revokeCredential(id);
        await hooks.ledger.markRevoked(row.sessionId, id);
      } catch {
        /* the mark stays unset — the NEXT sweep pass retries exactly this id */
      }
    }
  };
  if (TERMINAL_STATE_SNAP.has(row.state)) {
    if (row.revoked.caller && row.revoked.serving) return false; // fully collected
    await revokePending();
    return true;
  }
  if (opts.now <= row.exp + (opts.marginMs ?? 0)) return false;
  const moved = await hooks.ledger.transitionTerminal(row.sessionId, "expired");
  if (!moved) return false; // raced another terminator; its marks (or the next pass) finish the revokes
  await revokePending();
  return true;
}

// ---- the rails: framed protocol + bounded credit window --------------------------------------

/** The composite's own tiny framed protocol; `data` is OPAQUE (any JSON value — binary rides
 *  the application's own encoding). `credit`/`close` are CONTROL frames, EXEMPT from the data
 *  window (a full data window must never block the credits that reopen it, else instant
 *  deadlock). `ack` is an ABSOLUTE cumulative watermark (the sender's contiguous-received count
 *  on the OTHER rail): a data frame PIGGYBACKS it, so a lost dedicated credit self-heals on the
 *  next reverse data frame, and any deeper loss recovers on the keepalive re-emit; absolute
 *  (not delta) so any single credit re-advertises the whole position and a duplicate is
 *  harmless. The in-band `close` is advisory (§13.6): revocation authority is the ledger,
 *  never this frame. */
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
  /** Delivered in-order for CONTIGUOUS frames, and the application accepts FIRST: the handler
   *  may be async — it is AWAITED, and the watermark advances and credit emits only after it
   *  RESOLVES, so credit means the receiver's buffer actually freed (back-pressure) and a
   *  rejection refuses the frame exactly like a synchronous throw: the rail breaks (`handler`)
   *  and the refused frame is neither counted delivered nor credited. Acceptance is SERIALIZED
   *  in seq order (one handler in flight; NATS does not serialize callback promises); frames
   *  arriving while a handler is pending queue up to the grant WINDOW — past it the rail breaks
   *  (`flood`), never an unbounded backlog. A handler wedged forever stalls credit, so the
   *  SENDER's window fills and its stall watchdog surfaces the fault. A gap surfaces via
   *  onProtocolError("gap"). */
  onData(data: unknown, seq: number): void | Promise<void>;
  /** The peer's advisory close frame arrived (authoritative close is the ledger's). The local
   *  subscription and timer are torn down before this fires. */
  onClose?(): void;
  /** The session is broken — close and re-establish. `reason` is one of `garbled-frame` |
   *  `gap` | `credit-overrun` | `flood` | `subscription` | `stall` | `handler` | `publish` |
   *  `seq-exhausted`. The rail's subscription and timer are torn down before this fires (a
   *  broken rail holds no resources). */
  onProtocolError?(reason: string, detail?: unknown): void;
  /** Broker payload ceiling for the SEND preflight (like assertFactFits). Default 1 MiB. */
  maxPayloadBytes?: number;
  /** Keepalive credit re-emit interval (ms): while this side has delivered ANY data and the
   *  peer has gone quiet, re-advertise the absolute watermark every tick — including
   *  watermarks already advertised, because this side cannot observe whether an emitted
   *  credit ARRIVED (gating on "newer than last emitted" turns loss of the advertisement
   *  itself into a permanent stall). Absolute acks are idempotent, so the honest recovery is
   *  repetition; the cost is one control frame per quiet tick. 0 disables. Default 1000. */
  idleCreditMs?: number;
  /** Sender stall watchdog (ms): if the data window stays full this long with NO ack advance
   *  (sustained credit loss or a dead peer), the rail breaks with a DETECTABLE `stall` fault —
   *  TIMER-driven, so a sender that stops calling send() still learns its peer is gone; the
   *  send path double-checks as a belt. 0 disables. Default 30000. */
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
   *  is closed/broken (including a detected stall or a failed publish). Returns the frame's seq. */
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
 * RECEIVE-side acceptance is serialized and the (possibly async) handler AWAITED — credit
 * emits only for frames the application actually accepted — and the pending-frame queue is
 * bounded by the same window (`flood` past it), so neither side ever buffers unboundedly.
 * Credits carry an ABSOLUTE cumulative watermark, PIGGYBACKED on reverse data frames, so a lost
 * dedicated credit self-heals on the next reverse traffic; ANY deeper loss (including loss of
 * already-emitted threshold credits) recovers on the KEEPALIVE re-emit; sustained loss or a
 * dead peer surfaces the TIMER-driven `stall` fault (never a silent hang, even for a sender
 * that stopped calling send). A dropped DATA frame is unrecoverable at this transport (EPS is
 * at-most-once, core-only) and shows as a seq gap the app reacts to — reliability layers
 * inside `data` or uses the journal/checkpoint composites.
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
  let windowFullSince = 0; // when the window became full with no ack advance (0 = not blocked)
  let expected = 1; // next ingress data seq we can deliver contiguously
  let deliveredSinceCredit = 0;
  let dataSinceIdleTick = false; // did ingress data arrive since the last idle tick?
  let delivered = 0;
  let closed = false;
  let broken = false;
  let tornDown = false;
  let idleTimer: { unref?: () => void } | undefined;
  let sub: Subscription | undefined;
  const creditEvery = Math.max(1, Math.ceil(window / 2));

  // EXACTLY-ONCE local cleanup, whoever triggers it (local close, PEER close, or a protocol
  // fault): a remote peer must never be able to leave this side holding a dangling
  // subscription + interval per session (a remotely triggerable resource leak).
  const teardown = (): void => {
    if (tornDown) return;
    tornDown = true;
    if (idleTimer) clearIntervalFn(idleTimer);
    sub?.unsubscribe();
  };
  const protocolError = (reason: string, detail?: unknown): void => {
    broken = true;
    teardown(); // a broken rail holds no resources
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
    try {
      opts.nc.publish(egress, encodeSessionFrame({ t: "credit", ack: expected - 1 }));
    } catch (e) {
      protocolError("publish", (e as Error)?.message ?? String(e));
    }
  };

  // SERIALIZED data acceptance: the application accepts FIRST and may be ASYNC — NATS does not
  // serialize callback promises, so the callback only enqueues and this single drain loop runs
  // one handler at a time in seq order. The watermark advances and credit emits only after the
  // handler RESOLVES (credit == the receiver's buffer actually freed: the §13.6 back-pressure
  // semantic), so an async rejection refuses the frame exactly like a synchronous throw. The
  // HEAD frame stays queued while its handler runs, so the window bound below counts it; a
  // handler that resolves into a rail that closed or broke meanwhile advances NOTHING.
  const ingressQueue: Array<{ seq: number; data: unknown }> = [];
  let draining = false;
  const drain = async (): Promise<void> => {
    if (draining) return;
    draining = true;
    try {
      while (!closed && !broken && ingressQueue.length > 0) {
        const head = ingressQueue[0];
        try {
          await opts.onData(head.data, head.seq);
        } catch (e) {
          // A rejection landing in a rail that closed or broke DURING the await reports
          // NOTHING: the rail is already terminal (its fault, if any, was already surfaced),
          // and a second protocolError would double-fault a dead rail.
          if (closed || broken) return;
          protocolError("handler", (e as Error)?.message ?? String(e));
          return;
        }
        if (closed || broken) return;
        ingressQueue.shift();
        expected++;
        delivered++;
        deliveredSinceCredit++;
        if (deliveredSinceCredit >= creditEvery) {
          deliveredSinceCredit = 0;
          emitCredit();
        }
      }
    } finally {
      draining = false;
    }
  };

  sub = opts.nc.subscribe(ingress, {
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
        teardown();
        opts.onClose?.();
        return;
      }
      // Data. Its piggybacked ack refreshes OUR credit first (self-heals a lost dedicated
      // credit) — and an OVERRUNNING piggyback breaks the rail BEFORE the frame's data can
      // reach the application: a protocol-invalid frame must have no application effect.
      if (frame.ack !== undefined) {
        applyAck(frame.ack);
        if (broken) return;
      }
      dataSinceIdleTick = true;
      // Contiguity is judged against the queue's tail (the head may still be in its handler):
      // a peer sending in order while an earlier handler is pending is NOT a gap.
      const nextIngress = expected + ingressQueue.length;
      if (frame.seq < nextIngress) return; // duplicate — idempotent drop
      if (frame.seq > nextIngress) {
        protocolError("gap", { expected: nextIngress, got: frame.seq });
        return;
      }
      // The ingress queue is bounded by the grant WINDOW (an honest peer can never have more
      // unacknowledged frames in flight): a peer that ignores flow control while a handler is
      // pending cannot pile promises here — the rail breaks instead (§13.6: never unbounded).
      if (ingressQueue.length >= window) {
        protocolError("flood", { queued: ingressQueue.length, window });
        return;
      }
      ingressQueue.push({ seq: frame.seq, data: frame.data });
      void drain();
    },
  });

  // One tick drives BOTH recovery legs:
  //  - the KEEPALIVE credit re-emit: while this side has delivered anything and the peer went
  //    quiet, re-advertise the absolute watermark — deliberately NOT gated on what was already
  //    advertised (see idleCreditMs docs: the double-credit-loss counterexample).
  //  - the STALL WATCHDOG: a window that stays full past stallTimeoutMs with no ack advance
  //    breaks the rail with a DETECTABLE fault even if the sender never calls send() again.
  if (idleCreditMs > 0 || stallTimeoutMs > 0) {
    idleTimer = setIntervalFn(() => {
      if (closed || broken) return;
      if (stallTimeoutMs > 0 && windowFullSince !== 0) {
        const blockedMs = now() - windowFullSince;
        if (blockedMs > stallTimeoutMs) {
          protocolError("stall", { window, ackedThrough, sent: seq, blockedMs });
          return;
        }
      }
      if (idleCreditMs > 0 && !dataSinceIdleTick && expected > 1) emitCredit();
      dataSinceIdleTick = false;
    }, idleCreditMs > 0 ? idleCreditMs : 1000);
    idleTimer.unref?.();
  }

  return {
    send(data: unknown): number {
      if (closed || broken)
        throw new EpEnvelopeError("failed-precondition", "session rail is closed/broken; establish a new session (SPEC 13.6)");
      if (seq >= Number.MAX_SAFE_INTEGER - 1) {
        protocolError("seq-exhausted", { seq });
        throw new EpEnvelopeError("failed-precondition", "session rail exhausted its sequence space; establish a new session (SPEC 13.6)");
      }
      if (seq - ackedThrough >= window) {
        // The window is full. The timer is the primary stall detector; this path double-checks
        // (belt for a caller running with timers disabled) and otherwise refuses TRANSIENTLY.
        const t = now();
        if (windowFullSince === 0) windowFullSince = t;
        else if (stallTimeoutMs > 0 && t - windowFullSince > stallTimeoutMs) {
          protocolError("stall", { window, ackedThrough, sent: seq, blockedMs: t - windowFullSince });
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
      // Publish BEFORE advancing: a synchronous publish failure must not consume the seq (the
      // peer would otherwise see a permanent gap from a frame that never left this process,
      // and the local stats would count it in flight). A failed publish breaks the rail.
      try {
        opts.nc.publish(egress, frame);
      } catch (e) {
        protocolError("publish", (e as Error)?.message ?? String(e));
        throw new EpEnvelopeError("failed-precondition", `session rail publish failed; the rail is broken, re-establish (SPEC 13.6): ${(e as Error)?.message ?? String(e)}`);
      }
      seq++;
      // Arm the watchdog the moment the window BECOMES full: a sender that now only waits
      // (never calling send again) is still covered by the timer-driven stall check.
      if (seq - ackedThrough >= window && windowFullSince === 0) windowFullSince = now();
      return seq;
    },
    close(): void {
      if (closed) {
        teardown(); // idempotent; also covers close-after-broken
        return;
      }
      closed = true;
      try {
        opts.nc.publish(egress, encodeSessionFrame({ t: "close" }));
      } catch {
        /* advisory only — the ledger is the authority */
      }
      teardown();
    },
    stats() {
      return { sent: seq, ackedThrough, delivered, inFlight: seq - ackedThrough };
    },
  };
}
