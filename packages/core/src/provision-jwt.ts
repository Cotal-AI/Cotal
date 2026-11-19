import { decodeNatsJwt, nativeNkeySigner } from "./nkey-signer.js";
import { randomBytes } from "node:crypto";
import { decode, encodeOperator, encodeAccount, encodeUser, fmtCreds, type Account } from "@nats-io/jwt";
import { createOperator, createAccount, fromPublic, fromSeed } from "@nats-io/nkeys";
import { token, principalKey, principalTags, assertInboxConnId, DEV_OWNER, presenceKeySubject, type DeprovisionTarget, connzRequestSubject, accountCensusInboxPrefix } from "./subjects.js";
import { type EpCapability } from "./endpoint-grants.js";
import { assertServeGrantMintable, finalizeServeIssuance, type EpServeGrant, type EpIssuanceGate } from "./endpoint-service.js";
import { parseServiceConnectionBinding, type ServiceConnectionBinding } from "./service-gate.js";
import { SERVICE_ACCESS_TTL_SECONDS } from "./service-authority-limits.js";
import { importNativeSubjectPermissions, issuedHorizon, issuedPermitsPattern, prepareListing, writeAcceptedRow, type IssuanceSeam, type IssuedAuthorityRef, type ListingBinding, type ListingSeam, type PreparedListing } from "./issued-authority.js";
import { type RunDriverGrantArgs, type RunOperatorGrantArgs } from "./run-driver-grants.js";
import { credentialIdOf } from "./lifecycle-state.js";
import { isEnvironmentManagerProfile, type EnvironmentManagerGrantPin } from "./environment-manager-grants.js";
import { credsClaims, isAccountNkey, isUserNkey, type Identity } from "./identity.js";
import { type BackupPermissionScope, type RestorePermissionScope } from "./backup.js";
import type { Profile } from "./provision-permissions.js";
import { INSTRUMENT_PROFILES, connectionEvictorPermissions, endpointServePermissions, membershipObserverPermissions, permissionsFor } from "./provision-permissions.js";


export type CredentialLifetimeClass =
  | "standing-renewable" // bounded exp + an ONLINE renewal owner (a seed-holder re-mints before expiry)
  // The $SYS class: bounded exp but NOT online-renewable — the trust record is persisted without the
  // $SYS signing seed (saveSpaceAuth strips it), and the root's separate seed custody serves only
  // own-broker caller issuance, so no running process re-mints these. Their only renewal is
  // a coordinated system-account ROTATION (rotateSystemAccount) + broker restart. Named distinctly so
  // the "renewable" verb can never leak "online renewal" into the doctor/operator copy.
  | "rotation-renewed"
  | "one-shot"
  | "static-operator-managed"
  | "mixed";
export type CredentialKind = Profile | "membership-observer" | "account-census" | "connection-evictor";

export interface CredentialLifetimePolicy {
  class: CredentialLifetimeClass;
  /** Default max age at mint. Undefined = the profile mints no default exp. */
  defaultTtlSeconds?: number;
  renewalOwner?: string;
  note: string;
}

const FIVE_MINUTES = 5 * 60;

/** The broker's pre-auth control-line cap, in bytes (`max_control_line` in the generated config —
 *  `openServerConfig` and `serverConfig` below both render this literal, so the cap and the
 *  mint-time bound derived from it below can never drift). 64 KiB clears a many-channel agent
 *  JWT (~4-8 KB) with wide margin while keeping the pre-auth allocation ~16x tighter than 1 MB
 *  under connection flooding (the CONNECT line is parsed BEFORE auth). */
export const MAX_CONTROL_LINE_BYTES = 65536;

/** The fixed bytes a NATS client wraps around the `jwt` field on the CONNECT protocol line, over
 *  and above the JWT itself: the JSON object's other keys (`nkey`, `sig`, `name`, `lang`,
 *  `version`, `protocol`, `verbose`, `pedantic`, `no_responders`, `headers`), their values, and
 *  the surrounding braces/quotes/commas. Measured live (nats-server `-DV`, the trace of the raw
 *  protocol) on a real connect with the nats.js v3 client: a control-name credential produced a
 *  5,104-byte JWT inside a 5,291-byte CONNECT line — 187 bytes of envelope, reproduced twice.
 *  Rounded up generously (>2.5x) to absorb client/library variation this repo does not control. */
export const CONNECT_ENVELOPE_OVERHEAD_BYTES = 512;

/** The mint-time budget for a user JWT's byte size: every composition that inflates the JWT (a
 *  long single channel, many channels, the per-agent event channel, any grant a later change
 *  adds) is priced against the SAME number, because the credential is what the client sends on
 *  the CONNECT line and the CONNECT line is what the broker caps — not any one contributor to it.
 *  `assertValidName`/`assertValidChannel` bound one input each; this bounds the OUTPUT, closing
 *  the gap between "every individual grant is legal" and "the composed credential still fits"
 *  (issue #375's review finding: six distinct 4096-char channels, each individually accepted,
 *  minted a JWT the broker would silently drop). */
export const MAX_MINTED_JWT_BYTES = MAX_CONTROL_LINE_BYTES - CONNECT_ENVELOPE_OVERHEAD_BYTES;

/** Bounded lifetime for `standing-renewable` credentials whose renewal owner is ONLINE:
 *  the holder (or its launcher) re-mints at 75% of the lifetime via the endpoint's creds-source seam,
 *  so a copied cred is broker-dead within a day while renewal never involves an operator. 24h keeps
 *  the remaining-25% loud-failure window at ~6h — wide enough to notice and repair before expiry. */
export const STANDING_RENEWABLE_TTL_SEC = 24 * 60 * 60;

/** Bounded lifetime for the `rotation-renewed` $SYS credentials (membership-observer + connection-
 *  evictor). They are NOT online-renewable (the $SYS seed dies at end of `up`), so this exp is the
 *  credential-death horizon: a copied observer/evictor cred becomes broker-dead after it, and the
 *  operator is expected to have run a coordinated system-account rotation + broker restart within it
 *  (the doctor surface warns ahead). 30 days balances "copied cred eventually dies" against
 *  a comfortable monthly rotation cadence; tune here as one named knob. */
export const ROTATION_RENEWED_TTL_SEC = 30 * 24 * 60 * 60;

/** The credential lifetime matrix. This is intentionally centralized so every new mint profile must classify its
 * credential-death behavior instead of silently inheriting non-expiring static creds. */
export const CREDENTIAL_LIFETIMES: Record<CredentialKind, CredentialLifetimePolicy> = {
  agent: { class: "mixed", note: "manager children, foreground spawn/join, and `cotal mint` static outputs all use this profile; split or repair flow required before default exp" },
  "manager-caller": { class: "mixed", note: "short-lived user-auth view bound to the bearer expiry and one manager instance" },
  observer: { class: "static-operator-managed", note: "out-of-band dashboard/audit credential from `cotal mint`" },
  admin: { class: "static-operator-managed", note: "out-of-band elevated dashboard/audit credential from `cotal mint`" },
  supervisor: { class: "standing-renewable", defaultTtlSeconds: STANDING_RENEWABLE_TTL_SEC, renewalOwner: "manager", note: "manager's always-on endpoint; the manager holds the DATA seed and self-remints via the endpoint creds source" },
  delivery: { class: "standing-renewable", defaultTtlSeconds: STANDING_RENEWABLE_TTL_SEC, renewalOwner: "manager", note: "server-side Plane-3 daemon; seed-less - the manager re-signs .cotal/delivery.creds for the SAME nkey, requests delivery-admin reloadCreds for explicit adoption, and the endpoint source re-read is only a backstop" },
  "membership-rw": { class: "standing-renewable", defaultTtlSeconds: STANDING_RENEWABLE_TTL_SEC, renewalOwner: "manager", note: "membership feed writer; seed-less - the manager re-signs the membership-rw.creds store key for the SAME nkey, the feed adopts it on a 75% preflight-proven renewal timer (its active self-heal), and delivery-admin reloadCreds is the explicit adoption on top" },
  provisioner: { class: "one-shot", defaultTtlSeconds: FIVE_MINUTES, note: "setup/spawn provisioning window only" },
  deprovisioner: { class: "one-shot", defaultTtlSeconds: FIVE_MINUTES, note: "target-pinned teardown window only" },
  "retirement-requester": { class: "one-shot", defaultTtlSeconds: FIVE_MINUTES, note: "one despawn's retirement request window; request+reply only" },
  "lifecycle-executor": { class: "one-shot", defaultTtlSeconds: FIVE_MINUTES, note: "one static lifecycle operation's 13.1 state-write window (activation / terminal / renewal ledger append)" },
  "endpoint-serve-executor": { class: "one-shot", defaultTtlSeconds: FIVE_MINUTES, note: "one endpoint registration/serve-mint window (13.1 epgate CAS + epcred stage/revoke + eprepair cursor for one (endpoint, instanceId))" },
  operator: { class: "one-shot", defaultTtlSeconds: FIVE_MINUTES, note: "send/dm/join/probe-style operator command" },
  purger: { class: "one-shot", defaultTtlSeconds: FIVE_MINUTES, note: "history purge command" },
  backup: { class: "one-shot", defaultTtlSeconds: FIVE_MINUTES, note: "offline snapshot phase; exact stream and delivery subject, memory-only" },
  restore: { class: "one-shot", defaultTtlSeconds: FIVE_MINUTES, note: "offline restore initiation or exact-ID upload phase, memory-only" },
  "space-quiescence-reader": { class: "one-shot", defaultTtlSeconds: FIVE_MINUTES, note: "host-only idle-work observation; no writes, ACKs, consumer creation or renewal" },
  probe: { class: "one-shot", defaultTtlSeconds: 60, note: "connect-only preflight" },
  "channel-writer": { class: "one-shot", defaultTtlSeconds: FIVE_MINUTES, note: "channel registry mutation command" },
  "channel-purger": { class: "mixed", note: "one-shot for CLI, standing inside web; split or renewal required before default exp" },
  teardown: { class: "one-shot", note: "space teardown can be long/destructive; needs TTL budget/remint guard before default exp" },
  "membership-store-recreate": { class: "one-shot", defaultTtlSeconds: FIVE_MINUTES, note: "one stopped-space conversion of the derived membership stream from File to Memory; exact stream info/delete only" },
  "issued-store-recreate": { class: "one-shot", defaultTtlSeconds: 30 * 60, note: "one `up --recreate-issued-stores` step: snapshot and delete the two pre-retention issued-authority stores of one space; 30 minutes bounds a large store's snapshot" },
  "control-caller-privileged": { class: "one-shot", defaultTtlSeconds: FIVE_MINUTES, note: "ps/start control call" },
  "control-caller-admin": { class: "one-shot", defaultTtlSeconds: FIVE_MINUTES, note: "stop/attach admin control call" },
  deployer: { class: "one-shot", note: "manifest deploy spans planning/launch/ledger; needs near-expiry guard or remint before default exp" },
  "endpoint-serve": { class: "standing-renewable", defaultTtlSeconds: STANDING_RENEWABLE_TTL_SEC, renewalOwner: "manager", note: "per-instance endpoint serve credential (SPEC 13.9); the managing authority re-mints on renewal and on takeover (new epoch), and the 13.1 barrier revokes the superseded one" },
  "goal-writer": { class: "standing-renewable", defaultTtlSeconds: STANDING_RENEWABLE_TTL_SEC, renewalOwner: "manager", note: "self-mediated goal-writer for spawn-as-action; the manager re-mints for the SAME nkey on renewal, disjoint from the serve credential" },
  "session-caller": { class: "one-shot", defaultTtlSeconds: 24 * 60 * 60, note: "per-session console/CLI caller cred: rails-only for ONE §13.6 session; TTL-BOUND to the session (the face mints with expiresAt = the session exp; the 24h default is the SESSION_GRANT_MAX_TTL ceiling, never a standing lifetime); NEVER renewed - a new session mints a new cred" },
  "dm-reader": { class: "mixed", note: "user-auth own-DM reader view: one dm_ durable's INFO/NEXT/ACK, bound to the bearer expiry (which the IdP proof bounds); renewed by re-exchange, never a standing credential" },
  "session-serving": { class: "one-shot", defaultTtlSeconds: 24 * 60 * 60, note: "per-session SERVING cred: rails-only for ONE §13.6 session, the mirror of session-caller with the directions swapped; minted at redemption and TTL-BOUND to the session (the 24h default is the SESSION_GRANT_MAX_TTL ceiling, never a standing lifetime); NEVER renewed - a new session mints a new cred, and the session's terminal revokes this one by name" },
  "session-ledger": { class: "standing-renewable", defaultTtlSeconds: STANDING_RENEWABLE_TTL_SEC, renewalOwner: "manager", note: "manager's session LEDGER: the dedicated sessions-bucket `session.<id>` rows and NOTHING else - no session rail of any shape. Standing because SPEC 13.6 makes it the durable revocation authority that must survive the serving endpoint; the manager re-mints for the SAME nkey on the half-TTL loop (the goal-writer precedent)" },
  "run-driver": { class: "standing-renewable", defaultTtlSeconds: STANDING_RENEWABLE_TTL_SEC, renewalOwner: "manager", note: "one workflow run's driver, per takeover attempt (SPEC 14.6): the hosting manager mints it when it takes the run over and re-mints for the SAME nkey on renewal; a new takeover mints a new one" },
  "run-mediator": { class: "standing-renewable", defaultTtlSeconds: STANDING_RENEWABLE_TTL_SEC, renewalOwner: "manager", note: "trusted workflow host operations, bound to one run and attempt; kept on the hosting process's connection" },
  "run-operator": { class: "one-shot", defaultTtlSeconds: 60, note: "one served run-status / run-ps / run-answer call (SPEC 14.3): the hosting manager mints it per call on its own connection, never the serve rails; 60s bounds a copied cred to a minute" },
  "registry-reader": { class: "standing-renewable", defaultTtlSeconds: 60 * 60, renewalOwner: "registry host", note: "the registry's reads (SPEC 13.20), no write of any shape; the evidence-store read is stream-scoped, so it can read every recorded ceiling in the space (a NAMED RESIDUAL), and one hour bounds a copied credential; the process hosting the registry re-mints it" },
  issuer: { class: "mixed", defaultTtlSeconds: FIVE_MINUTES, renewalOwner: "auth-service", note: "renewed as the auth plane's held session for connect-time issuance (re-minted before exp, closed with the plane); one-shot for every other issuance window and for a lifecycle terminal's issuance retirement (SPEC 13.15)" },
  "run-admitter": { class: "one-shot", defaultTtlSeconds: 60, note: "one hosted run's admission record create, or its revocation marker (SPEC 14.8); 60s bounds a copied cred to a minute" },
  "transfer-writer": { class: "one-shot", defaultTtlSeconds: FIVE_MINUTES, note: "one carried resume per CLI call: one object's chunk and meta subjects in one instance's transfer bucket" },
  "transfer-reader": { class: "one-shot", defaultTtlSeconds: FIVE_MINUTES, note: "one transcript-receive or sweep over the minting instance's own transfer bucket" },
  "endpoint-evictor": { class: "one-shot", defaultTtlSeconds: 60, note: "one re-registration's verify-evict window: a scoped delivery-admin caller that kicks+verifies the SUPERSEDED serve family before the epoch advances; 60s bounds a copied cred to a minute" },
  "remote-manager": { class: "standing-renewable", defaultTtlSeconds: STANDING_RENEWABLE_TTL_SEC, renewalOwner: "auth-service", note: "the scoped remote manager lifecycle: own lease/presence plus same-owner agent provisioning; issued only by the typed supervise protocol, never by `cotal mint` or a raw view/profile string" },
  "environment-bootstrap": { class: "one-shot", defaultTtlSeconds: FIVE_MINUTES, note: "one admitted environment's bootstrap caller; explicit expiry capped by admission and five minutes" },
  "environment-manager-supervisor": { class: "standing-renewable", renewalOwner: "environment-authority", note: "own lease/presence/liveness; explicit expiry capped by admission, no auth-store access" },
  "environment-manager-executor": { class: "standing-renewable", renewalOwner: "environment-authority", note: "own admitted authority instance RPC; explicit expiry capped by admission, no direct store access" },
  "environment-manager-goal-writer": { class: "standing-renewable", renewalOwner: "environment-authority", note: "manager goal rows without the auth-read belt; explicit expiry capped by admission" },
  "membership-observer": { class: "rotation-renewed", defaultTtlSeconds: ROTATION_RENEWED_TTL_SEC, renewalOwner: "system-account rotation", note: "$SYS-account CONNZ observer; NOT online-renewable ($SYS seed dies at `up`) - bounded exp, renewed only by rotateSystemAccount + broker restart; doctor warns near expiry" },
  "account-census": { class: "one-shot", defaultTtlSeconds: FIVE_MINUTES, note: "Host-only account CONNZ and account-qualified replies; at most five minutes, no KICK or client-side renewal" },
  "connection-evictor": { class: "rotation-renewed", defaultTtlSeconds: ROTATION_RENEWED_TTL_SEC, renewalOwner: "system-account rotation", note: "$SYS-account KICK-only live-eviction cred; same rotation-renewed posture as the observer" },
};
// RUNTIME integrity (the afa715b class): the matrix and every policy freeze at module load
// (a post-import `defaultTtlSeconds = undefined` would otherwise mint a NON-EXPIRING credential
// out of a one-shot profile, executed repro), and the mint path below reads a PRIVATE TTL
// snapshot taken here, never the live export.
for (const p of Object.values(CREDENTIAL_LIFETIMES)) Object.freeze(p);
Object.freeze(CREDENTIAL_LIFETIMES);
const LIFETIME_TTL_SNAP: ReadonlyMap<string, number | undefined> = new Map(
  Object.entries(CREDENTIAL_LIFETIMES).map(([k, p]) => [k, p.defaultTtlSeconds]),
);

export function credentialLifetime(kind: CredentialKind): CredentialLifetimePolicy {
  return CREDENTIAL_LIFETIMES[kind];
}

/** A local credential file's health, by the SAME convention the renewal seam runs on: renewal is due
 *  at 75% of the iat→exp lifetime, so `near-expiry` means "past the point where a healthy renewal
 *  owner would already have re-signed this" — the doctor's yellow. `unreadable` (not a throw) is for
 *  a corrupt/spliced file: the doctor must render it red with a repair, not crash the diagnosis. */
export type CredHealthState = "healthy" | "near-expiry" | "expired" | "unbounded" | "unreadable";
export interface CredHealth {
  state: CredHealthState;
  /** Issue time (epoch sec) — the "last renewal" timestamp for reminted creds. */
  iat?: number;
  exp?: number;
  /** The 75%-of-lifetime renewal point (epoch sec); past it = near-expiry. */
  renewAt?: number;
  /** Present only for `unreadable`. */
  error?: string;
}

export function inspectCredHealth(creds: string, nowSec = Math.floor(Date.now() / 1000)): CredHealth {
  let claims: { iat?: number; exp?: number };
  try {
    claims = credsClaims(creds);
  } catch (e) {
    return { state: "unreadable", error: (e as Error).message };
  }
  const { iat, exp } = claims;
  if (typeof exp !== "number") return { state: "unbounded", iat };
  if (typeof iat !== "number") return { state: "unreadable", iat: undefined, exp, error: "user JWT carries exp but no iat - cannot place the renewal point" };
  const renewAt = Math.floor(iat + 0.75 * (exp - iat));
  if (nowSec >= exp) return { state: "expired", iat, exp, renewAt };
  if (nowSec >= renewAt) return { state: "near-expiry", iat, exp, renewAt };
  return { state: "healthy", iat, exp, renewAt };
}

/** BROKER-level trust: the operator root and the system account. A nats-server trusts exactly ONE
 *  operator and one system account, so this is the per-BROKER authority, not a per-space one. With
 *  many spaces on one broker every space's accounts are signed by this one operator.
 *
 *  `sys.signingSeed` is minting capability for system-account users (the membership observer and the
 *  connection evictor). It is in-memory only on a fresh {@link createBrokerAuth} and is NOT written
 *  by the local filesystem persistence, so on that path a space added after first boot cannot mint
 *  its `$SYS` users. A hosted composition that needs incremental space provisioning must hold this
 *  seed in a BROKER-scoped secret store (never a tenant-scoped one, which would give each tenant its
 *  own operator or duplicate the seed and so recreate multiple owners). */
export interface BrokerAuth {
  operator: { seed: string; jwt: string };
  sys: { pub: string; jwt: string; signingSeed?: string };
  /** Monotonic generation of the system-account authority. {@link rotateSystemAccount} bumps it
   *  IN MEMORY (each rotation is the next generation of the value it derived from); persistence
   *  (`saveBrokerAuth`) then only accepts a sys-changing write that is the DIRECT successor of the
   *  current record, refusing anything else as stale. Absent = 0 (in-memory creates and
   *  pre-generation records). The JWT `iat` cannot carry this ordering — it is second-resolution,
   *  so two generations minted within one second are unordered by it. */
  gen?: number;
}

/** SPACE-level trust: one space's data account, signed by its broker's operator. This is the only
 *  part of a space's trust material a space actually OWNS; broker trust is referenced, never owned
 *  (a per-space restore or rotation must not be able to move the broker's root). The `signingSeed`
 *  is the sensitive provisioner secret that mints this account's users. */
export interface SpaceAccountAuth {
  space: string;
  account: { pub: string; seed: string; jwt: string; signingSeed: string; signingPub: string };
}

/** The COMPOSED read view of one space's full trust chain: broker authority plus that space's
 *  account. Deliberately structurally identical to the single-space shape, so the many
 *  existing readers compose rather than churn.
 *
 *  This is a read adapter, never a persistence authority: it is produced by loading the two
 *  persisted records and validating their binding. Writing a composed value back as one document
 *  would let a mutation made through space A resurrect a stale broker copy when space B next loads
 *  it, which is exactly the ownership bug the split exists to prevent. */
export interface SpaceAuth extends BrokerAuth, SpaceAccountAuth {}

/** Compose the read view from its two persisted authorities. Fails loud when the space account was
 *  not signed by THIS broker's operator: a self-consistent account signed by a FOREIGN operator is
 *  perfectly valid on its own and would otherwise be rendered into the resolver as untrusted trust. */
export function composeSpaceAuth(broker: BrokerAuth, spaceAccount: SpaceAccountAuth): SpaceAuth {
  assertAccountSignedByBroker(broker, spaceAccount);
  return { ...broker, ...spaceAccount };
}

/** The binding check behind {@link composeSpaceAuth} and registry admission: this space's data
 *  account JWT must be issued by this broker's operator identity. */
export function assertAccountSignedByBroker(broker: BrokerAuth, spaceAccount: SpaceAccountAuth): void {
  if (!broker.operator.seed)
    throw new Error("assertAccountSignedByBroker: broker operator material is required to verify the account binding");
  let operatorPub: string;
  try {
    operatorPub = nativeNkeySigner(new TextEncoder().encode(broker.operator.seed)).getPublicKey();
  } catch {
    throw new Error("assertAccountSignedByBroker: the broker operator seed is not a valid operator seed");
  }
  const claims = decodeNatsJwt<{ iss?: string }>(spaceAccount.account.jwt);
  if (claims.iss !== operatorPub)
    throw new Error(
      `space "${spaceAccount.space}" account was signed by ${claims.iss ?? "an unknown issuer"}, not this broker's operator ${operatorPub} - refusing to compose trust across brokers`,
    );
}

// Unlimited account limits — without explicit limits a JWT account defaults to 0 conns
// (every connect denied). JetStream needs storage on the data account but MUST stay off
// the system account (the server refuses to start otherwise).
const BASE_LIMITS = {
  subs: -1, conn: -1, leaf: -1, imports: -1, exports: -1,
  data: -1, payload: -1, wildcards: true,
} as const;
const DATA_LIMITS = { ...BASE_LIMITS, mem_storage: -1, disk_storage: -1 };
const SYS_LIMITS = { ...BASE_LIMITS, mem_storage: 0, disk_storage: 0 };

/** Reduce a {@link SpaceAuth} to just the material a *minting* host needs: `space`,
 *  `account.pub`, and `account.signingSeed` (the only fields {@link mintCreds} reads).
 *  The operator root-of-trust, system account, and the account's own seed are blanked.
 *
 *  This is the file you hand a manager that should mint per-agent creds but must never
 *  hold the operator key — e.g. a containerized team. A leaked stripped file only lets
 *  someone mint *users within this one account*, which the account boundary already
 *  contains; it cannot mint new accounts or touch the system account. */
export function stripSpaceAuth(auth: SpaceAuth): SpaceAuth {
  return {
    space: auth.space,
    operator: { seed: "", jwt: "" },
    account: {
      pub: auth.account.pub,
      seed: "",
      jwt: "",
      signingSeed: auth.account.signingSeed,
      signingPub: "",
    },
    sys: { pub: "", jwt: "" },
  };
}

/** The user public keys a data-account JWT revokes, each with the Unix second it was revoked at. The
 *  broker refuses a user JWT for that key issued at or before that second. */
export function accountRevocations(accountJwt: string): Record<string, number> {
  return { ...decode<Account>(accountJwt).nats.revocations };
}

/** Re-issue the data-account JWT with the user key `userPub` revoked at `at` (Unix seconds), keeping
 *  every other claim. A key already revoked keeps its first time and the auth is returned unchanged.
 *  The broker applies it when it next loads its configuration. */
export async function revokeAccountUser(auth: SpaceAuth, userPub: string, at: number): Promise<SpaceAuth> {
  if (!auth.operator.seed)
    throw new Error("revokeAccountUser: the broker operator seed is required - a stripped broker cannot re-sign the space account");
  if (!isUserNkey(userPub)) throw new Error("revokeAccountUser: not a user public key");
  const claims = decode<Account>(auth.account.jwt);
  const revocations = claims.nats.revocations ?? {};
  if (revocations[userPub] !== undefined) return auth;
  const okp = fromSeed(new TextEncoder().encode(auth.operator.seed));
  const jwt = await encodeAccount(claims.name, auth.account.pub, { ...claims.nats, revocations: { ...revocations, [userPub]: at } }, { signer: okp });
  return { ...auth, account: { ...auth.account, jwt } };
}

/** Re-issue an account JWT that this broker's operator signed so the account serves nobody: every
 *  user key issued at or before `at` (Unix seconds) is revoked, and the account admits no client or
 *  leaf connection, so a user minted later is refused as well. Every other claim is kept, so the
 *  account's JetStream data stays where it is. Push the result with {@link pushAccountClaim} to stop
 *  a space on a running full-resolver broker; its live connections close without a reload. */
export async function retireAccountClaim(broker: BrokerAuth, accountJwt: string, at: number): Promise<string> {
  if (!broker.operator.seed)
    throw new Error("retireAccountClaim: the broker operator seed is required - a stripped broker cannot re-sign the account");
  if (!Number.isSafeInteger(at) || at <= 0) throw new Error("retireAccountClaim: at must be a positive whole number of Unix seconds");
  const okp = fromSeed(new TextEncoder().encode(broker.operator.seed));
  const claims = decode<Account>(accountJwt);
  if (claims.iss !== okp.getPublicKey() || !isAccountNkey(claims.sub ?? ""))
    throw new Error("retireAccountClaim: the account was not signed by this broker's operator - refusing to re-sign it");
  return encodeAccount(claims.name, claims.sub!, {
    ...claims.nats,
    limits: { ...claims.nats.limits, conn: 0, leaf: 0 },
    revocations: { ...claims.nats.revocations, "*": at },
  }, { signer: okp });
}

/** Rotate the SYSTEM account and re-issue the operator JWT so persisted system-account users (currently
 * `membership-observer`) become broker-dead once the broker loads the returned auth. The fresh
 * `sys.signingSeed` is intentionally in-memory only; callers must mint replacement observer creds before
 * persisting via `saveSpaceAuth`, which strips the seed again. */
export async function rotateSystemAccount(auth: SpaceAuth): Promise<SpaceAuth> {
  if (!auth.operator.seed)
    throw new Error("rotateSystemAccount: operator seed material is required (a stripped auth cannot rotate the system account)");
  const okp = fromSeed(new TextEncoder().encode(auth.operator.seed));
  const syskp = createAccount();
  const sysPub = syskp.getPublicKey();
  const operatorJwt = await encodeOperator(`cotal-${token(auth.space)}`, okp, { system_account: sysPub });
  const sysJwt = await encodeAccount("SYS", syskp, { limits: SYS_LIMITS }, { signer: okp });
  // The rotated value IS the next generation of whatever it derived from — persistence refuses a
  // sys change that is not the direct successor of the current record (see BrokerAuth.gen). The
  // input generation is runtime-validated: persisted records reach here through a bare JSON cast,
  // and a string/float/unsafe value would launder through the arithmetic ("0"+1 is "01"; at 2^53,
  // gen+1 === gen) and destroy the successor discriminator.
  // ONLY absence reads 0 (the pre-generation shape); an explicit null is tampering, same as any
  // other malformed value - `?? 0` would launder it into a valid generation-0 predecessor.
  const gen = auth.gen === undefined ? 0 : auth.gen;
  if (typeof gen !== "number" || !Number.isSafeInteger(gen) || gen < 0)
    throw new Error(`rotateSystemAccount: broker generation ${JSON.stringify(gen)} is not a non-negative integer - the loaded record is corrupt; restore it from backup`);
  return {
    ...auth,
    operator: { ...auth.operator, jwt: operatorJwt },
    sys: { pub: sysPub, jwt: sysJwt, signingSeed: new TextDecoder().decode(syskp.getSeed()) },
    gen: gen + 1,
  };
}

/** Generate a fresh BROKER trust root: operator → system account. One per broker, NOT one per space.
 *  `label` names the operator (cosmetic, but it lands in the operator JWT); multi-space brokers pass
 *  a broker label, and the single-space compatibility path passes the space name so existing
 *  operator names are unchanged.
 *
 *  The returned `sys.signingSeed` is the ONLY window in which system-account users (the membership
 *  observer and the connection evictor) can be minted, because the local filesystem persistence does
 *  not write it. Callers that need to add spaces later must retain it in a broker-scoped store. */
export async function createBrokerAuth(label: string): Promise<BrokerAuth> {
  const okp = createOperator();
  const syskp = createAccount();
  const sysPub = syskp.getPublicKey();
  const operatorJwt = await encodeOperator(`cotal-${token(label)}`, okp, { system_account: sysPub });
  const sysJwt = await encodeAccount("SYS", syskp, { limits: SYS_LIMITS }, { signer: okp });
  const dec = (u: Uint8Array) => new TextDecoder().decode(u);
  return {
    operator: { seed: dec(okp.getSeed()), jwt: operatorJwt },
    sys: { pub: sysPub, jwt: sysJwt, signingSeed: dec(syskp.getSeed()) },
  };
}

/** Generate one space's data account (+ signing key), signed by an EXISTING broker operator. This is
 *  the per-tenant half of provisioning: call it once per space against the same {@link BrokerAuth}
 *  to put many spaces on one broker, each in its own NATS account. Key generation and JWT
 *  construction stay with NATS; the existing native signer derives public keys and signs. */
export async function createSpaceAccountAuth(broker: BrokerAuth, space: string): Promise<SpaceAccountAuth> {
  if (!broker.operator.seed)
    throw new Error("createSpaceAccountAuth: the broker operator seed is required - a stripped broker cannot sign a new space account");
  const okp = nativeNkeySigner(new TextEncoder().encode(broker.operator.seed));
  const akp = nativeNkeySigner(createAccount().getSeed());
  const askp = nativeNkeySigner(createAccount().getSeed()); // account signing key - what mints users
  const accountJwt = await encodeAccount(
    token(space),
    akp,
    { signing_keys: [askp.getPublicKey()], limits: DATA_LIMITS },
    { signer: okp },
  );
  const dec = (u: Uint8Array) => new TextDecoder().decode(u);
  return {
    space,
    account: {
      pub: akp.getPublicKey(),
      seed: dec(akp.getSeed()),
      jwt: accountJwt,
      signingSeed: dec(askp.getSeed()),
      signingPub: askp.getPublicKey(),
    },
  };
}

/** Generate a fresh operator → account(+signing key) → system-account chain for a space.
 *  The single-space composition of {@link createBrokerAuth} + {@link createSpaceAccountAuth}: one
 *  broker whose only tenant is this space. */
export async function createSpaceAuth(space: string): Promise<SpaceAuth> {
  const broker = await createBrokerAuth(space);
  const spaceAccount = await createSpaceAccountAuth(broker, space);
  return { ...broker, ...spaceAccount };
}

/** An issuance's binding on a mint (SPEC 13.15): the generation, the token naming its accepted
 *  row, and whether the ceiling carries the registry's `endpoints` row. That flag is recorded with
 *  the issuance so a renewal mints the same ceiling it was issued with. */
export interface IssuedBinding {
  readonly generation: string;
  readonly acceptedToken: string;
  readonly listing?: true;
}

/** Options shaping a minted user's permissions. */
export interface MintOpts {
  /** Trusted issuance restriction: exclude the tool-payload publish rail when false. */
  eventPayloads?: boolean;
  /** The owner+actor principal to mint for. Omitted ⇒ the no-login dev default (owner `"local"`, actor
   *  = the connection id) via {@link principalOf}. User mode supplies the derived owner + ledger actor. */
  principal?: { owner: string; actor: string };
  /** Read ACL — channels an "agent" MAY read (the agent file's `allowSubscribe`, already resolved
   *  by the caller). Minted as per-channel single-filter history-consumer create grants
   *  (`CONSUMER.CREATE.<CHAT>.<chathist_id>.<chat.*.ch>`) — the broker boundary on chat **history**
   *  reads (join-backfill / focus-recall). Each is run through the chat-subject builder so a
   *  wildcard subtree `team.>` becomes `chat.*.team.>`. Omitted or empty ⇒ NO channel read rows at
   *  all (the cred carries no chat history grant and no `chat.*.<ch>` sub row); DM, presence,
   *  anycast and the control rails are unaffected. The live read is the agent's own native
   *  `sub.allow` over `chat.*.<channel>` (also minted from this list, below). */
  allowSubscribe?: string[];
  /** Post ACL — channels an "agent" may publish to (the agent file's `allowPublish`, already
   *  resolved by the caller). Each becomes a `chat.<id>.<ch>` publish grant. **Default-deny**:
   *  omitted/empty ⇒ no chat publish grant at all — publishing must be declared. */
  allowPublish?: string[];
  /** The agent's role — scopes its TASK-queue consumer to svc_<role>. */
  role?: string;
  /** Capabilities declared in the agent file (e.g. `"spawn"`). Each gates a set of manager ep
   *  caller rows in {@link permissionsFor}: `spawn` → {@link spawnCallerCapabilities}, `run` →
   *  {@link runCallerCapabilities}, `admin` → the admin {@link operatorInstrumentCapabilities} set.
   *  Default-deny when absent — nats-server rejects the publish, no handler involved. */
  capabilities?: string[];
  /** v0.4 endpoint request capabilities (SPEC §13.9 caller rows): each mints its exact
   *  request-publish rows (+ optional journal-append row) and, when any is present, the
   *  caller's own reply-rail read row. Requires {@link MintOpts.lifecycleUid} — the rows pin
   *  the full caller triple. Default-deny when absent. */
  endpointCapabilities?: EpCapability[];
  /** `manager-caller` profile only: the one manager instance every request row pins. */
  managerInstanceId?: string;
  /** The caller's lifecycle UID (SPEC §13.1), minted by the managing authority BEFORE the
   *  entity is reachable. REQUIRED with `endpointCapabilities` — every endpoint-rail row
   *  forge-locks it as the third caller token. */
  lifecycleUid?: string;
  /** v0.4 SERVE identity (SPEC §13.9 serve rows), `endpoint-serve` profile ONLY: mints the
   *  instance's queue-qualified class subscribes (no plain class-rail subscribe exists on any
   *  credential), the plain scatter and own `inst` rails for the FULL registered command set
   *  plus the derived `describe`, the own epoch-pinned timer-fire read, and the epoch-pinned
   *  egress (reply/epe/ept-schedule/epr). MUST be the branded ARTIFACT `authorizeServeGrant`
   *  returned — a raw literal, a structural copy, or a diverging value refuses at the mint, and
   *  the mint context is bound to the artifact (same space; the minted principal IS the
   *  registered owner). The freshness FENCE is the durable issuance gate ({@link serveIssuance}
   *  / SPEC §13.1), not this artifact. Every other profile refuses it (a serve credential is
   *  per-instance, never an agent-baseline cred). The `$JS.API` bind rows (effects/pool
   *  durables) ride `effectsBindGrants`/`poolOwnerBindGrants`, not this subject-space builder. */
  endpointServe?: EpServeGrant;
  /** v0.4 SERVE mint fence (SPEC §13.1), `endpoint-serve` profile ONLY and REQUIRED there: the
   *  durable, single-key issuance gate whose revision-pinned CAS `mintCreds` must WIN to release
   *  the serve credential. Both the takeover and re-registration barriers freeze this same gate,
   *  so a mint racing either loses the CAS and releases nothing. Production wires it to the
   *  credential ledger's endpoint family `epgate.<endpoint>.<instanceId>` (the auth
   *  implementation's `kvServeIssuanceGate`); a test provides a faithful CAS fake. */
  serveIssuance?: EpIssuanceGate;
  /** Delivery-daemon shard seam (`delivery` profile only). N=1 is the only operating mode; these do
   *  not change permissions in this build (the daemon owns the whole space at N=1). Present so the
   *  N>1 follow-up is a small diff. Default `{0,1}`. */
  shard?: number;
  shards?: number;
  /** The departed LIFECYCLE whose footprint a `deprovisioner` cred may tear down: the target's
   *  principal PLUS the exact lifecycle uid being retired (SPEC §13.1). REQUIRED for that profile (it
   *  throws without one): the grants are pinned to exactly this incarnation's
   *  `dm_<o>-<a>-<uid>`/`dlv_<o>-<a>-<uid>` durables + `<o>.<a>.<uid>` ACL row, so a leaked or
   *  REPLAYED deprovisioner cred can delete ONE retired incarnation's footprint and nothing else —
   *  never a peer's, never the role-shared `svc_<role>`, and structurally never a same-alias
   *  successor's (its names carry a different uid). Ignored by every other profile. */
  deprovisionTarget?: DeprovisionTarget;
  /** `retirement-requester` profile only: the REQUESTING CALLER TRIPLE (the current space-manager's
   *  own `owner`/`actor`/`uid`) whose auth-endpoint request subject the credential may publish, and
   *  whose reply rail it may read. The subject IS the attribution: the auth plane's rail derives
   *  the caller principal from the subject the broker admitted, and refuses unless the serve
   *  registration the request names belongs to THAT principal — so a requester cannot be authorized
   *  by another instance's registration.
   *
   *  The `uid` is why this carries a triple and not the pre-#350 `{owner, actor}` pair: the `ctl`
   *  rail's two-token subject could express only a recyclable alias, while the `ep` caller triple
   *  is `<owner>.<actor>.<uid>` and the grant pins all three. Ignored by every other profile. */
  retirementRequester?: {
    owner: string; actor: string; uid: string;
    /** The ONE incarnation this credential may ask to retire. It rides the SUBJECT as the
     *  `handle` target, so the grant pins it: a leaked requester cannot be re-aimed. */
    target: { owner: string; actor: string; lifecycleUid: string };
  };
  /** `lifecycle-executor` profile only (the static §13.1 executor): the ONE incarnation
   *  whose lifecycle-state keys this credential may write — the head `lifecycle.<owner>.<actor>`,
   *  the reservation `uid.<lifecycleUid>`, the gate `gate.<lifecycleUid>`, the ledger family
   *  `cred.<lifecycleUid>.>`, and the manager's durable slot row `mgrslot.<owner>.<alias>`.
   *  REQUIRED for that profile (it throws without one). EVERY key is DERIVED inside the profile
   *  from (owner, actor, lifecycleUid, alias) — none is a caller-supplied literal — so the pin is
   *  coherent by construction and a leaked executor cred can move exactly one incarnation's state
   *  machine and nothing else. Ignored by every other profile. */
  lifecycleExecutor?: { owner: string; actor: string; lifecycleUid: string; alias: string };
  /** `endpoint-serve-executor` profile only: the ONE endpoint instance whose
   *  endpoint-serve state this credential may write — the endpoint gate `epgate.<endpoint>.
   *  <instanceId>` (the registration barrier's freeze/reopen CAS + the provisioner create) and the
   *  serving ledger family `epcred.<endpoint>.<instanceId>.>` (the mint fence's stage + the barrier's
   *  revoke). REQUIRED for that profile. Every key is DERIVED inside the profile from
   *  (endpoint, instanceId) — none is a caller literal — so the manager drives the gate CAS + serve
   *  mint through THIS scoped executor and nothing else (the standing seed connection never writes
   *  the epgate or the epcred family). Ignored by every other profile. */
  endpointServeExecutor?: { endpoint: string; instanceId: string };
  /** `goal-writer` profile only (spawn-as-action): the endpoint whose action goals this
   *  standing connection may bind + commit ({@link goalWriterGrants}). REQUIRED for that profile;
   *  ignored by every other. */
  goalWriter?: { endpoint: string };
  /** `session-caller` profile only: the ONE §13.6 session whose two eps rails this
   *  credential may use — the serving endpoint, the fresh sessionId, and the serving epoch. REQUIRED
   *  for that profile; ignored by every other. The rows pin all three, so the cred authorizes
   *  exactly that session's `in`+`out` and nothing else. */
  sessionCaller?: { endpoint: string; sessionId: string; epoch: number };
  /** `session-serving` profile only: the ONE §13.6 session this SERVING credential may
   *  serve — same three coordinates as {@link sessionCaller}, with the rail directions swapped.
   *  REQUIRED for that profile; ignored by every other. The `session-ledger` profile takes no pin
   *  at all: it holds no rail, so it has nothing to pin. */
  sessionServing?: { endpoint: string; sessionId: string; epoch: number };
  /** `run-driver` profile only (SPEC 14.6): the ONE run this credential drives, the takeover attempt
   *  it is minted for (names the replay durable), and the driving instance's id and epoch (the
   *  coordinates its timer schedules are addressed by). REQUIRED for that profile; ignored by every
   *  other. The ep caller triple is DERIVED from the run id ({@link runDriverCaller}), never supplied. */
  runDriver?: RunDriverGrantArgs;
  /** Trusted host only: the run and takeover whose journal authorizes its effects. */
  runMediator?: RunDriverGrantArgs;
  /** `run-operator` profile only (SPEC 14.3): the ONE endpoint whose runs this credential may read,
   *  the takeover id its journal replays are named by, and, for the answering half of a
   *  `run-answer`, the ONE checkpoint token its answer and settle writes are pinned to. REQUIRED
   *  for that profile; ignored by every other. */
  runOperator?: RunOperatorGrantArgs;
  /** `remote-manager` profile only: the server-derived owner, fixed server-selected actor, and the
   * ONE locally-selected manager instance id this credential may supervise. REQUIRED for that profile. The builder pins its
   * manager lease/presence and same-owner provisioning resources; no caller-supplied subject rows
   * or profile fallback are accepted. */
  remoteManager?: { instanceId: string; owner: string; actor: string };
  /** Fixed environment profiles only. Host-derived pins confer no admission authority.
   * These profiles require explicit expiresAt, no later than this admission's expiry. */
  environmentManager?: EnvironmentManagerGrantPin;
  /** `deployer` profile only: which v0.4 ep instrument set its `launch`/`ps` rows carry. Defaults
   *  to `"admin"` (the static operator's ephemeral deploy cred). The user-mode `deployer` VIEW
   *  mints `"privileged"` instead, so a spawn-scoped deploy reaches the manager where its
   *  owner-equality launch authorization governs — never the admin any-mode reach. Ignored by
   *  every other profile. */
  controlTier?: "privileged" | "admin";
  /** Override the profile default lifetime. Internal/test hook; command surfaces should prefer the
   * centralized {@link CREDENTIAL_LIFETIMES} defaults so profile behavior stays auditable. */
  expiresInSeconds?: number;
  /** Absolute JWT `exp` timestamp in seconds. Used by cutover/test code that needs already-expired creds. */
  expiresAt?: number;
  /** Issued authority (SPEC 13.15): mint this credential's ep-rail rows on the VERSIONED rail,
   *  pinned to `generation`, and grant the per-key read of its accepted row. The issuer chose the
   *  generation and persisted its evidence before calling; the client chose `acceptedToken` and
   *  learns the accepted generation by reading that one row after it connects. Taken by the
   *  profiles that hold caller rails (`agent`, the operator instruments); every other profile
   *  refuses it. */
  issued?: IssuedBinding;
  /** A LISTING generation (SPEC 13.15, "Listing issuance"): the credential keeps the legacy rail
   *  for every row and gains exactly {@link listingGrantRows}. `agent` and `manager-caller` only,
   *  and never beside {@link MintOpts.issued}, whose own generation carries the listing. */
  listing?: ListingBinding;
  /** The issuer handles a static `agent` mint decides its listing generation over. The horizon is
   *  the credential's own expiry, so a mint with no expiry gets no listing generation. */
  listingSeam?: ListingSeam;
  /** `agent` profile only: the kind of the ledger row the principal was found in, which only the
   *  auth callout reads (SPEC 13.21). A row of either kind serves its own `agent` endpoint on the
   *  principal route; an `interactive` row, an actor its person granted directly, also calls its
   *  owner's agents there with the `owner` word. It never comes from a scope token, which a parent
   *  could hand to the agents it spawns. A static mint refuses it. */
  ledgerKind?: "interactive" | "managed-agent";
  /** The durable half of an issuance, REQUIRED beside {@link MintOpts.issued} on {@link mintCreds}:
   *  the credential is built first, then its evidence is staged create-only, the existing
   *  finalizer runs, and the attempt activates by CAS at the revision the stage observed; only
   *  then is the accepted row written and the material returned (SPEC 13.15). `renew` confirms an
   *  existing generation's ceiling is unchanged and stages nothing. */
  issuance?: IssuanceSeam;
  /** `run-admitter` profile only: the ONE hosted run whose admission record and revocation marker
   *  this connection may create. */
  runAdmitter?: { endpoint: string; runId: string; submission?: { caller: import("./endpoint-subjects.js").EpCaller; id: string } };
  /** `transfer-writer` profile only: the ONE object (the transcript's hex digest) in the ONE manager
   *  instance's transfer bucket this instrument may write. */
  transferWriter?: { instanceId: string; hex: string };
  /** `transfer-reader` profile only: the manager instance whose own transfer bucket this reads. */
  transferReader?: { instanceId: string };
  /** `teardown` profile only: the space's transfer streams, listed before the mint, that this
   *  teardown may inspect and delete by name ({@link deleteSpace} lists and names them). */
  transferStreams?: string[];
  /** `backup` profile only: one discriminated inspector or snapshot phase. */
  backup?: BackupPermissionScope;
  /** `restore` profile only: one discriminated initiate, upload, validate, or checkpoint phase. */
  restore?: RestorePermissionScope;
}

/** The principal tags every user JWT carries, plus one random issuance tag on a goal-writer or
 *  session-ledger credential. Those two profiles carry no epoch-pinned grant, so two mints for one
 *  nkey within one second would otherwise sign identical bytes, and their ledger row is keyed by the
 *  JWT digest: a restart's re-mint would re-sign the credential its barrier just revoked under the
 *  revoked row's id (SPEC 13.1). */
function userTags(profile: Profile, pr: MintPrincipal): string[] {
  const tags = principalTags(pr.owner, pr.actor);
  return profile === "goal-writer" || profile === "session-ledger" ? [...tags, `issuance:${randomBytes(16).toString("hex")}`] : tags;
}

/** Compute a minted credential's `{ exp? }` from an explicit override or the centralized matrix
 *  default. Widened to {@link CredentialKind} (not just {@link Profile}) so the bespoke $SYS minters
 *  — `membership-observer` / `connection-evictor`, which are kinds, not profiles — thread the same
 *  bounded-lifetime policy instead of minting non-expiring $SYS creds. */
function userValidDates(kind: CredentialKind, opts: MintOpts): { exp?: number } {
  if (isEnvironmentManagerProfile(kind)) {
    const now = Math.floor(Date.now() / 1000);
    const admissionExpiry = opts.environmentManager?.expiresAt;
    const expiry = opts.expiresAt;
    if (typeof admissionExpiry !== "number" || !Number.isSafeInteger(admissionExpiry) || admissionExpiry <= now ||
        typeof expiry !== "number" || !Number.isSafeInteger(expiry) || expiry <= now || expiry > admissionExpiry)
      throw new Error(`mintCreds: ${kind} requires a current explicit expiresAt no later than admission expiry`);
    if (kind === "environment-bootstrap" && expiry > now + FIVE_MINUTES)
      throw new Error("mintCreds: environment-bootstrap expiry exceeds its five-minute lifetime");
  }
  if (opts.expiresAt !== undefined && opts.expiresInSeconds !== undefined)
    throw new Error("mintCreds: pass only one of expiresAt or expiresInSeconds");
  if (opts.expiresAt !== undefined) {
    if (!Number.isInteger(opts.expiresAt) || opts.expiresAt < 0)
      throw new Error("mintCreds: expiresAt must be a non-negative integer timestamp (seconds)");
    return { exp: opts.expiresAt };
  }
  const ttl = opts.expiresInSeconds ?? LIFETIME_TTL_SNAP.get(kind);
  if (ttl === undefined) return {};
  if (!Number.isInteger(ttl) || ttl <= 0) throw new Error("mintCreds: expiresInSeconds must be a positive integer");
  return { exp: Math.floor(Date.now() / 1000) + ttl };
}

/** The identity a cred is minted for: the owner+actor wire principal PLUS the connection nkey the cred
 *  authenticates as. The wire grammar, per-agent KV keys, durables and presence key off owner+actor; the
 *  private reply inbox (`_INBOX_<connId>`) keys off the connection nkey — under the auth callout that is a
 *  per-connection ephemeral the client always knows, whereas the derived owner is not known pre-connect. */
export interface MintPrincipal {
  owner: string;
  actor: string;
  connId: string;
  /** The incarnation's lifecycle UID (SPEC §13.1). REQUIRED for the `agent` profile — its
   *  dm/dlv/chathist grants are lifecycle-keyed EXACT names, so a credential cannot name another
   *  incarnation's resources. Other profiles ignore it. */
  lifecycleUid?: string;
  /** The connection's history-reader id, the key of the observer and admin profiles' reader deletes
   *  ({@link historyReaderConsumer}). A static mint leaves it unset, because there `connId` is the
   *  credential's own nkey, which its holder proves by signing. The auth callout sets it to
   *  {@link calloutReaderId}, because there `connId` is the inbox nonce the client chose. */
  readerId?: string;
}

/** Resolve a {@link MintPrincipal} for the STATIC/dev mint path from an {@link Identity} + optional
 *  explicit principal. No-login dev default: owner = {@link DEV_OWNER} ("local"), actor = the connection
 *  id, so the agent's lane is `local.<id>`. The connection nkey is always the identity's id here (the
 *  creds bind to it). User mode does NOT flow through here — the callout mints directly with the
 *  server-derived owner + ledger actor. */
function principalOf(
  identity: Identity,
  principal?: { owner: string; actor: string },
  lifecycleUid?: string,
): MintPrincipal {
  return {
    owner: principal?.owner ?? DEV_OWNER,
    actor: principal?.actor ?? identity.id,
    connId: identity.id,
    ...(lifecycleUid !== undefined ? { lifecycleUid } : {}),
  };
}


/** Mint a user creds file for an agent {@link Identity} (its stable id+seed from
 *  {@link newIdentity}). The account signing key signs over ONLY the public key
 *  (`fromPublic`) — the agent seed is never part of the signature, it's only folded into
 *  the resulting creds file. The "agent" profile is scoped to publish only as itself and only to
 *  its declared `allowPublish` channels (post ACL, default-deny), and to read only within
 *  `allowSubscribe` (live tail bind-only + per-channel history grants). Every profile is now
 *  enumerated least-privilege — there is no allow-all cred (the former `manager` is deleted). */
export async function mintCreds(
  auth: SpaceAuth,
  identity: Identity,
  profile: Profile,
  opts: MintOpts = {},
): Promise<string> {
  // For third-party endpoints, an issued static agent credential carries only untargeted,
  // unjournaled commands. The static lifecycle terminal has no SPEC 13.1 obligation drain, so a
  // targeted or journaled grant could leave accepted work keyed to a retired lifecycle that nothing
  // settles. Refused before anything is signed or staged. The guard covers every issued agent mint:
  // the managed spawn (through provisionAgent), the managed renewal and the foreground spawn. An
  // unissued mint skips it, so a future caller that hands a static agent endpoint commands must mint
  // it issued. The guard skips every reference endpoint, meaning any single-label name such as
  // `manager` (SPEC 13.2). The skip goes by the name and does not check which command a row names.
  // The rows an instance-pinned caller passes here are the manager's own, the ones the `spawn`,
  // `run` and `admin` capabilities mint, and issued agent mints carried them before this guard
  // existed. A persona cannot name a reference endpoint, so the hand-on path never reaches the skip.
  if (profile === "agent" && opts.issued) {
    const drained = opts.endpointCapabilities?.find((c) => c.endpoint.includes(".") && (c.target !== undefined || c.journal));
    if (drained)
      throw new Error(`mintCreds: for third-party endpoints, an issued static agent credential carries only untargeted, unjournaled commands; "${drained.endpoint} ${drained.command}" is ${drained.target !== undefined ? "targeted" : "journaled"}, and the static lifecycle terminal has no obligation drain to settle what it could leave (SPEC 13.1, 13.15)`);
  }
  const signer = nativeNkeySigner(new TextEncoder().encode(auth.account.signingSeed));
  const pr = principalOf(identity, opts.principal, opts.lifecycleUid);
  // Serve rows are INTERNAL to mintCreds behind the §13.1 fence: the exported permissionsFor
  // refuses "endpoint-serve" (so a direct caller can never obtain unfenced serve rows), and only
  // this fenced path calls the row builder.
  const validDates = userValidDates(profile, opts);
  const listing = await prepareStaticListing(auth.space, profile, pr, opts, validDates.exp);
  const perms = profile === "endpoint-serve"
    ? endpointServePermissions(auth.space, pr, opts)
    : listing?.permissions ?? permissionsFor(profile, auth.space, pr, opts);
  const userJwt = await encodeUser(
    profile,
    fromPublic(identity.id),
    fromPublic(auth.account.pub),
    // Stamp the principal `tags` so this connection's identity is CONNZ-recoverable by the membership
    // feed — the SAME tags the auth callout stamps (user mode), via core's single-source builder. The
    // JWT `name` stays the profile label (a debug breadcrumb; not a surfaced/queryable CONNZ field).
    { ...perms, tags: userTags(profile, pr) },
    { signer, ...validDates },
  );
  // Build the credential string FULLY before the fence: nothing fallible may run AFTER a winning
  // CAS, or a post-CAS throw would leave a committed ledger row with no released credential (an
  // orphan authority record). fmtCreds only wraps the already-signed JWT with the seed, so it is
  // done here and the fence is the mint's LAST step.
  const creds = new TextDecoder().decode(fmtCreds(userJwt, fromSeed(new TextEncoder().encode(identity.seed))));
  // The composed-credential bound (SPEC 13.9, issue #375's review finding): every individual grant
  // input can pass its own validator (assertValidName, assertValidChannel) and the COMPOSED JWT
  // still exceed the CONNECT line the broker caps, because nothing bounded the COUNT of channels
  // an agent's allowSubscribe/allowPublish may carry. Refuse here, BEFORE releaseIssuance (the
  // file's own no-fallible-work-after-a-winning-CAS rule, stated above) — a refusal here has
  // released no ledger row, unlike a refusal after.
  const userJwtBytes = Buffer.byteLength(userJwt, "utf8");
  if (userJwtBytes > MAX_MINTED_JWT_BYTES) {
    const channelCount = (opts.allowSubscribe?.length ?? 0) + (opts.allowPublish?.length ?? 0);
    throw new Error(
      `mintCreds: minted JWT is ${userJwtBytes} bytes, exceeding the ${MAX_MINTED_JWT_BYTES}-byte ` +
        `mint bound (${channelCount} allowSubscribe+allowPublish channel(s)) - the composed credential ` +
        `would exceed the broker's CONNECT line and the connect would hang silently (issue #375)`,
    );
  }
  await listing?.commit();
  await releaseIssuance(auth.space, profile, pr, opts, perms, validDates.exp, credentialIdOf(creds));
  // §13.1 mint fence for the serve credential: the credential is BUILT, but released only when its
  // NORMATIVE ledger row (holderPrincipal/lifecycleUid/sourceChain/state/exp + the currency
  // coordinates) is durably staged and its revision-pinned CAS wins the instance's single issuance
  // gate (still `open` at the authorized epoch + registrationRevision + nameAuthorityRevision). A
  // takeover, re-registration, or name transfer that froze the gate first makes this lose and
  // release nothing. A read is never a fence, so this is a CAS write, not an in-memory mark.
  if (profile === "endpoint-serve") {
    if (!opts.serveIssuance)
      throw new Error("mintCreds: endpoint-serve requires opts.serveIssuance (the durable issuance-gate seam; the mint releases only on its revision-pinned CAS win, SPEC 13.1)");
    await finalizeServeIssuance(opts.serveIssuance, opts.endpointServe!, {
      // PER-ISSUED-JWT id (digest of the credential): `exp` and `iat` have whole-second Unix
      // resolution and `jti` is derived from the claims, so what keeps a re-registered successor
      // serve credential off its revoked predecessor's row within the same second is the
      // epoch-pinned serve grant (`endpointServe.epoch` in the permission rows). A renewal in a
      // later second gets a fresh `iat`/`exp` and writes a new ledger row; a same-second renewal
      // at one epoch signs identical bytes and re-stages the same active row, which the
      // create-only / idempotent-if-identical stage seam accepts as a retry while refusing a
      // revoked row with `conflict`. The stable nkey rides separately as `credentialKey` for
      // broker revocation. KEY-SAFE digest form (`sha256-<hex>`, never the §13.7 `sha256:`
      // artifact form): the id becomes a segment of the durable `epcred.` KV key, whose grammar
      // has no ":".
      credentialId: credentialIdOf(creds),
      credentialKey: identity.id,
      holderActor: pr.actor,
      // A serve credential is minted directly by the provisioner authority, so its §13.1 issuance
      // lineage is the root anchor (not owner/actor principal components).
      sourceChain: ["root"],
      ...(validDates.exp !== undefined ? { exp: validDates.exp } : {}),
    });
  }
  return creds;
}

/** A static `agent` mint's listing generation (SPEC 13.15, "Listing issuance"), decided before the
 *  credential is signed. Its horizon is the credential's own expiry, so a mint with none gets no
 *  listing generation. Bound to no gate: the evidence's expiry is its liveness. */
async function prepareStaticListing(space: string, profile: Profile, pr: MintPrincipal, opts: MintOpts, exp: number | undefined): Promise<PreparedListing | undefined> {
  const seam = opts.listingSeam;
  if (!seam) return undefined;
  if (profile !== "agent") throw new Error(`mintCreds: a listing seam rides the static agent mint only, not "${profile}"`);
  if (opts.issued || opts.listing) throw new Error("mintCreds: a listing seam decides the listing generation itself; opts.issued and opts.listing are refused beside it");
  if (exp === undefined) return undefined;
  if (!pr.lifecycleUid) throw new Error("mintCreds: a listing generation is lifecycle-keyed; mint with opts.lifecycleUid");
  return prepareListing(
    seam,
    { space, owner: pr.owner, actor: pr.actor, uid: pr.lifecycleUid, connId: pr.connId, horizon: exp, sources: [], expiresAt: exp },
    (binding) => permissionsFor(profile, space, pr, { ...opts, ...(binding ? { listing: binding } : {}) }),
  );
}

/** The SPEC 13.15 issuance fence: an issuing mint persists the ceiling it is handing out BEFORE
 *  the material is returned, and the material expires by its generation's horizon. The evidence is the minted permission set itself (deny rules
 *  included), imported from the same object the JWT was encoded from, so the record and the
 *  credential cannot disagree. `sources` name the gates the issuance depends on; an issuance bound
 *  to none (a one-shot instrument) carries the credential's own expiry as its liveness. A renewal
 *  confirms the existing generation's ceiling is unchanged and records nothing new. */
async function releaseIssuance(
  space: string,
  profile: Profile,
  pr: MintPrincipal,
  opts: MintOpts,
  perms: Record<string, unknown>,
  exp: number | undefined,
  credentialId: string,
): Promise<void> {
  if (!opts.issued) {
    if (opts.issuance) throw new Error("mintCreds: opts.issuance without opts.issued; an issuance names its generation");
    return;
  }
  const seam = opts.issuance;
  if (!seam) throw new Error(`mintCreds: an issued "${profile}" mint requires opts.issuance (the evidence store seam); the material is released only after its evidence is durable (SPEC 13.15)`);
  if (!pr.lifecycleUid) throw new Error("mintCreds: an issuance is lifecycle-keyed; mint with opts.lifecycleUid");
  const ref: IssuedAuthorityRef = { space, owner: pr.owner, actor: pr.actor, uid: pr.lifecycleUid, generation: opts.issued.generation };
  // Every credential minted on a generation ends by its horizon: past it the generation authorizes
  // nothing and its rows may be gone, so material outliving it would ride a dead binding.
  if (exp === undefined || exp > issuedHorizon(ref.generation))
    throw new Error(`mintCreds: an issued credential must expire by its generation's horizon ${issuedHorizon(ref.generation)} (SPEC 13.15)`);
  const permissions = importNativeSubjectPermissions(perms);
  if (seam.mode === "renew") {
    await seam.store.confirm(ref, permissions);
    await seam.finalize?.(credentialId);
    return;
  }
  // The spawn bound reads an issuance with no source and no presence key of its own as an operator
  // instrument (grant-bound.ts, issuedSpawnerStanding), so only an instrument profile is issued that
  // way. Any other profile issued without a source must carry its own presence key.
  if (seam.sources.length === 0 && !INSTRUMENT_PROFILES.has(profile) && !issuedPermitsPattern(permissions.publish, presenceKeySubject(space, pr.owner, pr.actor)))
    throw new Error(`mintCreds: a "${profile}" issuance with no source must carry its own presence key, or the spawn bound would read it as an operator instrument (SPEC 13.15)`);
  const prepared = await seam.store.stage({
    version: 1,
    ref,
    sources: seam.sources,
    permissions,
    ...(seam.sources.length === 0 ? { expiresAt: exp } : {}),
  });
  await seam.store.release(prepared, async () => { await seam.finalize?.(credentialId); });
  await writeAcceptedRow(seam.accepted, opts.issued.acceptedToken, ref);
}

/** Issue a host-signed NATS user JWT for a caller-generated nkey. The private seed stays with
 * the remote manager. This is deliberately narrower than {@link mintCreds}: only the typed remote
 * manager protocol may request it, and every profile still goes through the same permission and
 * lifetime builders. It signs with the space account's signing key alone, so a host that holds
 * only that key passes no placeholder broker trust. */
export async function mintPublicUserJwt(
  auth: { space: string; account: Pick<SpaceAccountAuth["account"], "pub" | "signingSeed"> },
  publicId: string,
  profile: Profile,
  opts: MintOpts,
): Promise<{ jwt: string; exp: number }> {
  if (!isUserNkey(publicId)) throw new Error("mintPublicUserJwt: publicId must be a user nkey");
  if (!isEnvironmentManagerProfile(profile) && !["remote-manager", "endpoint-serve", "goal-writer", "session-ledger", "session-serving", "retirement-requester", "run-driver", "run-mediator", "run-operator", "transfer-reader"].includes(profile))
    throw new Error(`mintPublicUserJwt: profile "${profile}" is not part of the closed remote manager protocol`);
  const pr: MintPrincipal = {
    owner: opts.principal?.owner ?? DEV_OWNER,
    actor: opts.principal?.actor ?? publicId,
    connId: publicId,
    ...(opts.lifecycleUid ? { lifecycleUid: opts.lifecycleUid } : {}),
  };
  const perms = profile === "endpoint-serve"
    ? endpointServePermissions(auth.space, pr, opts)
    : permissionsFor(profile, auth.space, pr, opts);
  const validDates = userValidDates(profile, opts);
  if (validDates.exp === undefined) throw new Error(`mintPublicUserJwt: profile "${profile}" must be bounded`);
  const jwt = await encodeUser(profile, fromPublic(publicId), fromPublic(auth.account.pub),
    { ...perms, tags: userTags(profile, pr) },
    { signer: nativeNkeySigner(new TextEncoder().encode(auth.account.signingSeed)), ...validDates });
  // Same composed-credential bound as mintCreds (see MAX_MINTED_JWT_BYTES): this JWT is presented
  // on a real CONNECT line by the remote manager, so it is priced against the same budget before
  // any fallible finalize step below. None of this function's profiles read allowSubscribe/
  // allowPublish today (each returns through its own dedicated permission builder), so the count
  // is always 0 here - the check stays live in case a future profile addition changes that.
  const jwtBytes = Buffer.byteLength(jwt, "utf8");
  if (jwtBytes > MAX_MINTED_JWT_BYTES) {
    const channelCount = (opts.allowSubscribe?.length ?? 0) + (opts.allowPublish?.length ?? 0);
    throw new Error(
      `mintPublicUserJwt: minted JWT is ${jwtBytes} bytes, exceeding the ${MAX_MINTED_JWT_BYTES}-byte ` +
        `mint bound (${channelCount} allowSubscribe+allowPublish channel(s)) - the composed credential ` +
        `would exceed the broker's CONNECT line and the connect would hang silently (issue #375)`,
    );
  }
  if (profile === "endpoint-serve") {
    if (!opts.serveIssuance) throw new Error("mintPublicUserJwt: endpoint-serve requires serveIssuance");
    await finalizeServeIssuance(opts.serveIssuance, opts.endpointServe!, {
      credentialId: credentialIdOf(jwt),
      credentialKey: publicId,
      holderActor: pr.actor,
      sourceChain: ["root"],
      exp: validDates.exp,
    });
  }
  return { jwt, exp: validDates.exp };
}

/** Host-only service-callout mint. The host authenticates the connection and bearer, fixes
 * expiry before authority reads, and keeps this JWT inside its encrypted authorization response.
 * Native root reauthorization and natkey recording remain the host's final release obligations.
 */
export async function mintServiceCalloutJwt(
  auth: { space: string; account: Pick<SpaceAccountAuth["account"], "pub" | "signingSeed"> },
  args: {
    serve: EpServeGrant; gate: EpIssuanceGate; principal: { owner: string; actor: string };
    connection: ServiceConnectionBinding; inboxNonce: string;
    admittedAt: number; accessExpiresAt: number; expiresAt: number;
  },
): Promise<{ jwt: string; credentialId: string; iat: number; exp: number }> {
  const connection = parseServiceConnectionBinding(args.connection), inboxNonce = assertInboxConnId(args.inboxNonce);
  const principal = { ...args.principal }, { serve, gate, admittedAt, accessExpiresAt, expiresAt } = args;
  const now = Math.floor(Date.now() / 1000);
  if (![admittedAt, accessExpiresAt, expiresAt].every((v) => Number.isSafeInteger(v) && v > 0)
    || admittedAt > now || expiresAt <= now || expiresAt > accessExpiresAt || expiresAt > admittedAt + SERVICE_ACCESS_TTL_SECONDS)
    throw new Error("service callout mint requires the original admission-bounded expiry");
  const identity = principalKey(principal.owner, principal.actor);
  const snapshot = assertServeGrantMintable(serve, { space: auth.space, holderOwner: principal.owner });
  if (snapshot.journalClass || snapshot.pools.length || snapshot.commands.some((command) => serve.surface[command].class !== "ephemeral"))
    throw new Error("service callout mint supports only standalone ephemeral serving grants");
  const permissions = endpointServePermissions(auth.space, { ...principal, connId: inboxNonce },
    { endpointServe: serve, serveIssuance: gate });
  const jwt = await encodeUser(identity.name, fromPublic(connection.userNkey), fromPublic(auth.account.pub),
    { ...permissions, tags: principalTags(principal.owner, principal.actor) },
    { signer: nativeNkeySigner(new TextEncoder().encode(auth.account.signingSeed)), exp: expiresAt });
  if (Buffer.byteLength(jwt, "utf8") > MAX_MINTED_JWT_BYTES)
    throw new Error("service callout mint exceeds the native JWT byte limit");
  const credentialId = credentialIdOf(jwt);
  await finalizeServeIssuance(gate, serve, { credentialId, credentialKey: connection.userNkey,
    serviceConnection: connection, holderActor: principal.actor, sourceChain: ["root"], exp: expiresAt });
  if (expiresAt <= Math.floor(Date.now() / 1000))
    throw new Error("service callout mint expired before release; its fixed expiry is not extended");
  return { jwt, credentialId, iat: decode(jwt).iat, exp: expiresAt };
}

/** Mint the scoped `membership-observer` creds — a SYSTEM-account user (conn A of the graph feed),
 *  signed with the in-memory `auth.sys.signingSeed` from a fresh {@link createSpaceAuth}. THROWS if that
 *  seed is absent (a re-`up` of an already-provisioned space, whose `$SYS` seed was discarded at its
 *  original `up`): the observer can only be minted at the (re-)provision that creates the account — a
 *  documented migration property, not a silent no-op. The CONNZ/event subjects pin the DATA account id
 *  (`auth.account.pub`). Mirrors {@link mintCreds} but issues into the system account. */
export async function mintMembershipObserverCreds(auth: SpaceAuth, identity: Identity, opts: MintOpts = {}): Promise<string> {
  if (!auth.sys.signingSeed)
    throw new Error(
      "mintMembershipObserverCreds: no in-memory system-account signing seed - the observer can only be minted from a system account that is being (re)provisioned, because the trust record carries no $SYS seed. Rotate the system account to mint a fresh one (`cotal down` then `cotal up --rotate-sys`); a plain re-`up` reuses the existing account and its existing creds.",
    );
  const signer = nativeNkeySigner(new TextEncoder().encode(auth.sys.signingSeed));
  const perms = membershipObserverPermissions(auth.account.pub);
  // Bounded exp: the observer is `rotation-renewed` — it carries the matrix's default
  // lifetime so a copied cred becomes broker-dead, but there is NO online renewal (the $SYS seed is
  // gone after `up`); renewal is a coordinated system-account rotation + restart.
  const validDates = userValidDates("membership-observer", opts);
  const userJwt = await encodeUser(
    "membership-observer",
    fromPublic(identity.id),
    fromPublic(auth.sys.pub),
    perms,
    { signer, ...validDates },
  );
  const creds = fmtCreds(userJwt, fromSeed(new TextEncoder().encode(identity.seed)));
  return new TextDecoder().decode(creds);
}

/** Host-only read-only census credential. A registered system signer is required; no fallback
 * to a broader observer or eviction credential. Reissuing with a retained registered signer
 * needs no broker restart. The helper does not discover or persist that signer.
 */
export async function mintAccountCensusCreds(
  auth: { account: { pub: string }; sys: { pub: string; signingSeed?: string } },
  identity: Identity, opts: MintOpts = {},
): Promise<string> {
  const prefix = accountCensusInboxPrefix(auth.account.pub);
  if (!auth.sys.signingSeed) throw new Error("account census requires the registered system-account signer");
  const { exp } = userValidDates("account-census", opts), now = Math.floor(Date.now() / 1000);
  if (exp === undefined || !Number.isSafeInteger(exp) || exp <= now || exp > now + FIVE_MINUTES)
    throw new Error("account census requires a bounded future credential expiry");
  const user = fromSeed(new TextEncoder().encode(identity.seed));
  if (!isUserNkey(identity.id) || user.getPublicKey() !== identity.id) throw new Error("account census identity does not match its user key");
  const jwt = await encodeUser("account-census", fromPublic(identity.id), fromPublic(auth.sys.pub), {
    pub: { allow: [connzRequestSubject(auth.account.pub)] }, sub: { allow: [`${prefix}.>`] },
  }, { signer: nativeNkeySigner(new TextEncoder().encode(auth.sys.signingSeed)), exp });
  if (exp <= Math.floor(Date.now() / 1000)) throw new Error("account census credential expired before release");
  return new TextDecoder().decode(fmtCreds(jwt, user));
}

/** Mint the scoped `connection-evictor` creds — the kick-only SYSTEM-account user for live
 *  eviction. Same mint-only-at-provision property as the observer (the $SYS seed is in-memory
 *  only), same fail-loud when it's absent. Paired with the observer at `up`. */
export async function mintConnectionEvictorCreds(auth: SpaceAuth, identity: Identity, opts: MintOpts = {}): Promise<string> {
  if (!auth.sys.signingSeed)
    throw new Error(
      "mintConnectionEvictorCreds: no in-memory system-account signing seed - the evictor can only be minted from a system account that is being (re)provisioned, because the trust record carries no $SYS seed. Rotate the system account to mint a fresh one (`cotal down` then `cotal up --rotate-sys`); a plain re-`up` reuses the existing account and its existing creds.",
    );
  const signer = nativeNkeySigner(new TextEncoder().encode(auth.sys.signingSeed));
  // Bounded exp: `rotation-renewed`, same posture as the observer above.
  const validDates = userValidDates("connection-evictor", opts);
  const userJwt = await encodeUser(
    "connection-evictor",
    fromPublic(identity.id),
    fromPublic(auth.sys.pub),
    connectionEvictorPermissions(),
    { signer, ...validDates },
  );
  const creds = fmtCreds(userJwt, fromSeed(new TextEncoder().encode(identity.seed)));
  return new TextDecoder().decode(creds);
}

export { principalOf };
