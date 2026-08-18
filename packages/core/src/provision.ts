/**
 * The provisioner — the signer capability for a space.
 *
 * A space is one NATS *account*; every agent is a *user* in it. This module mints the
 * decentralized-JWT trust chain (operator → account → user) programmatically with
 * `@nats-io/jwt`, so there is no dependency on the external `nsc` CLI and the signing
 * key stays in one place (whoever holds {@link SpaceAuth.account.signingSeed}).
 *
 * Demo-1 stage: out-of-band mint. `cotal up` creates the space's trust material
 * once and writes a `nats-server` config (operator + system account + MEMORY resolver);
 * `cotal mint` and the manager load that material and mint per-agent creds files. There
 * is no connect-time token exchange yet (that's the later auth-callout stage).
 *
 * D5 adds the first credential-death primitive: profile-classified user-JWT lifetimes. Full revocation,
 * live eviction, standing-host renewal, and issuance audit still land in later D5 slices.
 */
import { ttlBuckets } from "./streams.js";
import { join } from "node:path";
import {
  decode,
  encodeOperator,
  encodeAccount,
  encodeUser,
  fmtCreds,
} from "@nats-io/jwt";
import { createOperator, createAccount, fromPublic, fromSeed } from "@nats-io/nkeys";
import type { BrokerTransport } from "./broker-tls.js";
import {
  token,
  spacePrefix,
  chatSubject,
  assertValidChannel,
  channelInAllow,
  principalKey,
  parsePrincipalKey,
  deprovisionTargetPrincipal,
  principalTags,
  assertInboxConnId,
  DEV_OWNER,
  unicastSubject,
  anycastSubject,
  controlServiceSubject,
  CONTROL_DELIVERY,
  CONTROL_DELIVERY_ADMIN,
  artifactBucket,
  objectStoreStream,
  chatStream,
  dmStream,
  taskStream,
  dlvStream,
  inboxStream,
  chatHistDurable,
  dmDurable,
  taskDurable,
  dlvDurable,
  presenceBucket,
  channelBucket,
  membersBucket,
  aclBucket,
  aclKey,
  assertLifecycleToken,
  type DeprovisionTarget,
  membershipBucket,
  deliveryBucket,
  managerBucket,
  MANAGER_LEASE_KEY,
  connzRequestSubject,
  accountConnectSubject,
  accountDisconnectSubject,
  MEMBERSHIP_INBOX_PREFIX,
  FANOUT_DURABLE,
  INBOX_READER_DURABLE,
} from "./subjects.js";
import {
  epCallerGrantRows, epServeGrantRows, epBaselineGrantRows, spawnCallerCapabilities, epRequestGrantRows,
  operatorInstrumentCapabilities, epDescribeAllGrantRow, BASELINE_LIFECYCLE_ENDPOINT,
  type EpCapability,
} from "./endpoint-grants.js";
import { assertServeGrantMintable, finalizeServeIssuance, type EpServeGrant, type EpIssuanceGate } from "./endpoint-service.js";
import { effectsBindGrants, poolOwnerBindGrants, goalWriterGrants, sessionLedgerGrants, epAuthBucket, sessionsBucket, epcStreamName, epjStreamName, epfStreamName, epeStreamName, eptReqStreamName, eprStreamName, eptStreamName, epwStreamName, wfjStreamName } from "./endpoint-binding.js";
import { epsSubject, epCallerReplyFilter, AUTH_ENDPOINT, EP_CMD_RETIRE_LIFECYCLE } from "./endpoint-subjects.js";
import { recordsBucket, recordSpecKey, recordStatusKey, recordAtomicKey, RECORD_KINDS, GOVERN_HEAD } from "./endpoint-records.js";
import { lifecycleHeadKey, uidReservationKey, issuanceGateKey, staticSlotKey, STATIC_SLOT_PREFIX, epgateKey, epcredFamilyPrefix } from "./lifecycle-state.js";
import { rawDigest } from "./canonical.js";
import { credsClaims, type Identity } from "./identity.js";
import {
  backupProfilePermissions,
  restoreProfilePermissions,
  type BackupPermissionScope,
  type RestorePermissionScope,
} from "./backup.js";

/** Cred profiles. Each profile has an explicit permission arm and a D5 lifetime classification. */
export type Profile =
  | "agent"
  | "observer"
  | "admin"
  | "supervisor"
  | "provisioner"
  | "deprovisioner" // ephemeral, TARGET-PINNED teardown of ONE departed agent's id-keyed footprint (#159 B)
  | "retirement-requester" // ephemeral request+reply on the auth-admin rail (#29 piece 3): asks the AUTH plane to retire a lifecycle; holds NO executing right
  | "lifecycle-executor" // ephemeral, LIFECYCLE-PINNED §13.1 state writes for the STATIC manager (Unit B): exactly ONE incarnation's head/uid/gate/cred-row/slot keys
  | "endpoint-serve-executor" // ephemeral, ENDPOINT-INSTANCE-PINNED §13.1 endpoint-serve writes (P2 item 1, 1a-serve): exactly ONE (endpoint, instanceId)'s epgate + epcred family
  | "operator"
  | "purger"
  | "backup"
  | "restore"
  | "delivery"
  | "membership-rw"
  // PR 1.5 — the CLI-surface profiles that finish scoping (and DELETE) the former allow-all `manager`.
  | "probe" // connect-only liveness/auth preflight
  | "channel-writer" // channel-registry value-writes (channels set/default, spawn -f seed)
  | "channel-purger" // channel-writer + STREAM.PURGE.CHAT (web channel-delete)
  | "teardown" // the SOLE STREAM.DELETE holder (down -f space teardown)
  // Control callers — the manager's control tiers are SUBJECT-gated (holding the tier's pub grant IS
  // the authority), so ps/start and stop/attach get SEPARATE, tier-scoped caller creds.
  | "control-caller-privileged" // ps/start → ctl.<privileged>.<id> only (no cross-agent reach)
  | "control-caller-admin" // stop/attach → ctl.<admin>.<id> only (cross-agent power)
  | "deployer" // spawn -f deploy authority: reads + admin-control launch on one ephemeral cred
  // v0.4 control surface (SPEC §13.9): the per-instance endpoint serve credential — EXACTLY the
  // instance's registered rails + epoch-pinned egress, no agent baseline. Consumes only an
  // authorizeServeGrant-branded tuple; re-minted on takeover with the new epoch.
  | "endpoint-serve"
  // v0.4 action surface (P2 item 2, spawn-as-action): the SELF-MEDIATED goal-writer for an endpoint
  // that accepts action goals inline on its ephemeral handler — EXACTLY that endpoint's goal
  // bind/terminal facts + goal-record writes ({@link goalWriterGrants}), a dedicated connection
  // disjoint from the serve credential (Q2). Standing, re-minted on renewal like the serve cred.
  | "goal-writer"
  // The console/CLI per-session CALLER credential (P2 item 6): rails-only for ONE §13.6 session,
  // TTL-bound to it, never standing. Static = face-minted from the seed; user mode = the callout.
  | "session-caller"
  // The manager's SERVING per-session credential (P2 item 6): the mirror of `session-caller` with
  // the directions swapped — sub the ONE session's `in` rail, pub its `out` rail, nothing else.
  // Minted at redemption, TTL-bound to the session, never renewed (SPEC 13.6: both sides hold only
  // redemption-minted per-session credentials; no standing EPS grant exists on either side).
  | "session-serving"
  // The manager's SESSION LEDGER (P2 item 6): the standing connection owning the DEDICATED
  // sessions-bucket `session.<id>` rows — §13.6's "durable named authority that survives the
  // serving endpoint". Holds NO session rail of any shape; the rails are `session-serving`'s and
  // `session-caller`'s. Standing + re-minted for the SAME nkey on renewal (the goal-writer precedent).
  | "session-ledger"
  // v0.4 endpoint-registration eviction (P2 item 3, slice 3a): the SCOPED delivery-admin caller a
  // registration barrier mints PER re-registration to verify-evict the SUPERSEDED serve family
  // before the epoch advances (SPEC 13.1 "old authority dies before new authority is visible").
  // EXACTLY the delivery-admin request+reply rail + $JS.API.INFO — no lease, presence, store read,
  // consumer, KV, or executing right; the daemon does the $SYS scan/KICK, the manager passes only
  // the predecessor's principal. Ephemeral (one re-registration's window), narrower than the
  // `supervisor` profile the auth barrier-evict reuses (its #30 residual, done here for the manager).
  | "endpoint-evictor";

export type CredentialLifetimeClass =
  | "standing-renewable" // bounded exp + an ONLINE renewal owner (a seed-holder re-mints before expiry)
  // The $SYS class: bounded exp but NOT online-renewable — the $SYS signing seed is destroyed at end
  // of `up` (saveSpaceAuth strips it), so no running process can re-mint these. Their only renewal is
  // a coordinated system-account ROTATION (rotateSystemAccount) + broker restart. Named distinctly so
  // the "renewable" verb can never leak "online renewal" into the doctor/operator copy (D5 slice 5).
  | "rotation-renewed"
  | "one-shot"
  | "static-operator-managed"
  | "mixed";
export type CredentialKind = Profile | "membership-observer" | "connection-evictor";

export interface CredentialLifetimePolicy {
  class: CredentialLifetimeClass;
  /** Default max age for profiles safe to expire before the renewal slice. Undefined = no default exp yet. */
  defaultTtlSeconds?: number;
  renewalOwner?: string;
  note: string;
}

const FIVE_MINUTES = 5 * 60;

/** Bounded lifetime for `standing-renewable` credentials whose renewal owner is ONLINE (D5 slice 5):
 *  the holder (or its launcher) re-mints at 75% of the lifetime via the endpoint's creds-source seam,
 *  so a copied cred is broker-dead within a day while renewal never involves an operator. 24h keeps
 *  the remaining-25% loud-failure window at ~6h — wide enough to notice and repair before expiry. */
export const STANDING_RENEWABLE_TTL_SEC = 24 * 60 * 60;

/** Bounded lifetime for the `rotation-renewed` $SYS credentials (membership-observer + connection-
 *  evictor). They are NOT online-renewable (the $SYS seed dies at end of `up`), so this exp is the
 *  credential-death horizon: a copied observer/evictor cred becomes broker-dead after it, and the
 *  operator is expected to have run a coordinated system-account rotation + broker restart within it
 *  (the doctor surface warns ahead — slice 6). 30 days balances "copied cred eventually dies" against
 *  a comfortable monthly rotation cadence; tune here as one named knob. */
export const ROTATION_RENEWED_TTL_SEC = 30 * 24 * 60 * 60;

/** D5 profile matrix. This is intentionally centralized so every new mint profile must classify its
 * credential-death behavior instead of silently inheriting non-expiring static creds. */
export const CREDENTIAL_LIFETIMES: Record<CredentialKind, CredentialLifetimePolicy> = {
  agent: { class: "mixed", note: "manager children, foreground spawn/join, and cotal mint static outputs all use this profile; split or repair flow required before default exp" },
  observer: { class: "static-operator-managed", note: "out-of-band dashboard/audit credential from cotal mint" },
  admin: { class: "static-operator-managed", note: "out-of-band elevated dashboard/audit credential from cotal mint" },
  supervisor: { class: "standing-renewable", defaultTtlSeconds: STANDING_RENEWABLE_TTL_SEC, renewalOwner: "manager", note: "manager's always-on endpoint; the manager holds the DATA seed and self-remints via the endpoint creds source (D5 slice 5 class 1)" },
  delivery: { class: "standing-renewable", defaultTtlSeconds: STANDING_RENEWABLE_TTL_SEC, renewalOwner: "manager", note: "server-side Plane-3 daemon; seed-less - the manager re-signs .cotal/delivery.creds for the SAME nkey, requests delivery-admin reloadCreds for explicit adoption, and the endpoint source re-read is only a backstop (D5 slice 5 class 2)" },
  "membership-rw": { class: "standing-renewable", defaultTtlSeconds: STANDING_RENEWABLE_TTL_SEC, renewalOwner: "manager", note: "membership feed writer; seed-less - the manager re-signs the membership-rw.creds store key for the SAME nkey, the feed adopts it on a 75% preflight-proven renewal timer (its active self-heal), and delivery-admin reloadCreds is the explicit adoption on top (D5 slice 5 class 2)" },
  provisioner: { class: "one-shot", defaultTtlSeconds: FIVE_MINUTES, note: "setup/spawn provisioning window only" },
  deprovisioner: { class: "one-shot", defaultTtlSeconds: FIVE_MINUTES, note: "target-pinned teardown window only" },
  "retirement-requester": { class: "one-shot", defaultTtlSeconds: FIVE_MINUTES, note: "one despawn's retirement request window; request+reply only" },
  "lifecycle-executor": { class: "one-shot", defaultTtlSeconds: FIVE_MINUTES, note: "one static lifecycle operation's 13.1 state-write window (activation / terminal / renewal ledger append)" },
  "endpoint-serve-executor": { class: "one-shot", defaultTtlSeconds: FIVE_MINUTES, note: "one endpoint registration/serve-mint window (13.1 epgate CAS + epcred stage/revoke for one (endpoint, instanceId))" },
  operator: { class: "one-shot", defaultTtlSeconds: FIVE_MINUTES, note: "send/dm/join/probe-style operator command" },
  purger: { class: "one-shot", defaultTtlSeconds: FIVE_MINUTES, note: "history purge command" },
  backup: { class: "one-shot", defaultTtlSeconds: FIVE_MINUTES, note: "offline snapshot phase; exact stream and delivery subject, memory-only" },
  restore: { class: "one-shot", defaultTtlSeconds: FIVE_MINUTES, note: "offline restore initiation or exact-ID upload phase, memory-only" },
  probe: { class: "one-shot", defaultTtlSeconds: 60, note: "connect-only preflight" },
  "channel-writer": { class: "one-shot", defaultTtlSeconds: FIVE_MINUTES, note: "channel registry mutation command" },
  "channel-purger": { class: "mixed", note: "one-shot for CLI, standing inside web; split or renewal required before default exp" },
  teardown: { class: "one-shot", note: "space teardown can be long/destructive; needs TTL budget/remint guard before default exp" },
  "control-caller-privileged": { class: "one-shot", defaultTtlSeconds: FIVE_MINUTES, note: "ps/start control call" },
  "control-caller-admin": { class: "one-shot", defaultTtlSeconds: FIVE_MINUTES, note: "stop/attach admin control call" },
  deployer: { class: "one-shot", note: "manifest deploy spans planning/launch/ledger; needs near-expiry guard or remint before default exp" },
  "endpoint-serve": { class: "standing-renewable", defaultTtlSeconds: STANDING_RENEWABLE_TTL_SEC, renewalOwner: "manager", note: "per-instance endpoint serve credential (SPEC 13.9); the managing authority re-mints on renewal and on takeover (new epoch), and the 13.1 barrier revokes the superseded one" },
  "goal-writer": { class: "standing-renewable", defaultTtlSeconds: STANDING_RENEWABLE_TTL_SEC, renewalOwner: "manager", note: "self-mediated goal-writer for spawn-as-action (P2 item 2); the manager re-mints for the SAME nkey on renewal, disjoint from the serve credential (Q2)" },
  "session-caller": { class: "one-shot", defaultTtlSeconds: 24 * 60 * 60, note: "per-session console/CLI caller cred (P2 item 6): rails-only for ONE §13.6 session; TTL-BOUND to the session (the face mints with expiresAt = the session exp; the 24h default is the SESSION_GRANT_MAX_TTL ceiling, never a standing lifetime); NEVER renewed - a new session mints a new cred" },
  "session-serving": { class: "one-shot", defaultTtlSeconds: 24 * 60 * 60, note: "per-session SERVING cred (P2 item 6): rails-only for ONE §13.6 session, the mirror of session-caller with the directions swapped; minted at redemption and TTL-BOUND to the session (the 24h default is the SESSION_GRANT_MAX_TTL ceiling, never a standing lifetime); NEVER renewed - a new session mints a new cred, and the session's terminal revokes this one by name" },
  "session-ledger": { class: "standing-renewable", defaultTtlSeconds: STANDING_RENEWABLE_TTL_SEC, renewalOwner: "manager", note: "manager's session LEDGER (P2 item 6): the dedicated sessions-bucket `session.<id>` rows and NOTHING else - no session rail of any shape. Standing because SPEC 13.6 makes it the durable revocation authority that must survive the serving endpoint; the manager re-mints for the SAME nkey on the half-TTL loop (the goal-writer precedent)" },
  "endpoint-evictor": { class: "one-shot", defaultTtlSeconds: 60, note: "one re-registration's verify-evict window (P2 item 3): a scoped delivery-admin caller that kicks+verifies the SUPERSEDED serve family before the epoch advances; 60s bounds a copied cred to a minute" },
  "membership-observer": { class: "rotation-renewed", defaultTtlSeconds: ROTATION_RENEWED_TTL_SEC, renewalOwner: "system-account rotation", note: "$SYS-account CONNZ observer; NOT online-renewable ($SYS seed dies at `up`) - bounded exp, renewed only by rotateSystemAccount + broker restart; doctor warns near expiry" },
  "connection-evictor": { class: "rotation-renewed", defaultTtlSeconds: ROTATION_RENEWED_TTL_SEC, renewalOwner: "system-account rotation", note: "$SYS-account KICK-only live-eviction cred (D5 slice 4); same rotation-renewed posture as the observer" },
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
 *  many spaces on one broker (W4) every space's accounts are signed by this one operator.
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
 *  account. Deliberately structurally identical to the pre-W4 single-space shape, so the many
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
    operatorPub = fromSeed(new TextEncoder().encode(broker.operator.seed)).getPublicKey();
  } catch {
    throw new Error("assertAccountSignedByBroker: the broker operator seed is not a valid operator seed");
  }
  const claims = decode<{ iss?: string }>(spaceAccount.account.jwt);
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

/** Rotate the DATA-account signing key and re-issue the data-account JWT so the old data signer is no
 * longer trusted by the broker once it loads the returned auth. This does NOT rotate the system account:
 * persisted `membership-observer` creds remain valid until the system-account renewal/rotation slice. */
export async function rotateDataAccountSigningKey(auth: SpaceAuth): Promise<SpaceAuth> {
  if (!auth.operator.seed || !auth.account.seed)
    throw new Error("rotateDataAccountSigningKey: full operator/account seed material is required (a stripped signer cannot rotate trust)");
  const okp = fromSeed(new TextEncoder().encode(auth.operator.seed));
  const akp = fromSeed(new TextEncoder().encode(auth.account.seed));
  const askp = createAccount();
  const signingPub = askp.getPublicKey();
  const accountJwt = await encodeAccount(
    token(auth.space),
    akp,
    { signing_keys: [signingPub], limits: DATA_LIMITS },
    { signer: okp },
  );
  return {
    ...auth,
    account: {
      ...auth.account,
      jwt: accountJwt,
      signingSeed: new TextDecoder().decode(askp.getSeed()),
      signingPub,
    },
  };
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
 *  to put many spaces on one broker, each in its own NATS account. */
export async function createSpaceAccountAuth(broker: BrokerAuth, space: string): Promise<SpaceAccountAuth> {
  if (!broker.operator.seed)
    throw new Error("createSpaceAccountAuth: the broker operator seed is required - a stripped broker cannot sign a new space account");
  const okp = fromSeed(new TextEncoder().encode(broker.operator.seed));
  const akp = createAccount();
  const askp = createAccount(); // account signing key - what mints users
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
 *  broker whose only tenant is this space, which is exactly the pre-W4 shape. */
export async function createSpaceAuth(space: string): Promise<SpaceAuth> {
  const broker = await createBrokerAuth(space);
  const spaceAccount = await createSpaceAccountAuth(broker, space);
  return { ...broker, ...spaceAccount };
}

/** Options shaping a minted user's permissions. */
export interface MintOpts {
  /** The owner+actor principal to mint for. Omitted ⇒ the no-login dev default (owner `"local"`, actor
   *  = the connection id) via {@link principalOf}. User mode supplies the derived owner + ledger actor. */
  principal?: { owner: string; actor: string };
  /** Read ACL — channels an "agent" MAY read (the agent file's `allowSubscribe`, already resolved
   *  by the caller). Minted as per-channel single-filter history-consumer create grants
   *  (`CONSUMER.CREATE.<CHAT>.<chathist_id>.<chat.*.ch>`) — the broker boundary on chat **history**
   *  reads (join-backfill / focus-recall). Each is run through the chat-subject builder so a
   *  wildcard subtree `team.>` becomes `chat.*.team.>`. Defaults to `["general"]`. The live read is the
   *  agent's own native `sub.allow` over `chat.*.<channel>` (also minted from this list, below). */
  allowSubscribe?: string[];
  /** Post ACL — channels an "agent" may publish to (the agent file's `allowPublish`, already
   *  resolved by the caller). Each becomes a `chat.<id>.<ch>` publish grant. **Default-deny**:
   *  omitted/empty ⇒ no chat publish grant at all — publishing must be declared. */
  allowPublish?: string[];
  /** The agent's role — scopes its TASK-queue consumer to svc_<role>. */
  role?: string;
  /** Capabilities declared in the agent file (e.g. `"spawn"`). A capability gates the
   *  privileged control-subject grant in {@link permissionsFor}: `spawn` → the agent may
   *  publish to the privileged control subject (start/purge/definePersona/named stop).
   *  Default-deny when absent — nats-server rejects the publish, no handler involved. */
  capabilities?: string[];
  /** v0.4 endpoint request capabilities (SPEC §13.9 caller rows): each mints its exact
   *  request-publish rows (+ optional journal-append row) and, when any is present, the
   *  caller's own reply-rail read row. Requires {@link MintOpts.lifecycleUid} — the rows pin
   *  the full caller triple. Default-deny when absent. */
  endpointCapabilities?: EpCapability[];
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
   *  durables) ride the D14 credential assembly, not this subject-space builder. */
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
  /** `lifecycle-executor` profile only (Unit B, the static §13.1 executor): the ONE incarnation
   *  whose lifecycle-state keys this credential may write — the head `lifecycle.<owner>.<actor>`,
   *  the reservation `uid.<lifecycleUid>`, the gate `gate.<lifecycleUid>`, the ledger family
   *  `cred.<lifecycleUid>.>`, and the manager's durable slot row `mgrslot.<owner>.<alias>`.
   *  REQUIRED for that profile (it throws without one). EVERY key is DERIVED inside the profile
   *  from (owner, actor, lifecycleUid, alias) — none is a caller-supplied literal — so the pin is
   *  coherent by construction and a leaked executor cred can move exactly one incarnation's state
   *  machine and nothing else. Ignored by every other profile. */
  lifecycleExecutor?: { owner: string; actor: string; lifecycleUid: string; alias: string };
  /** `endpoint-serve-executor` profile only (P2 item 1, 1a-serve): the ONE endpoint instance whose
   *  endpoint-serve state this credential may write — the endpoint gate `epgate.<endpoint>.
   *  <instanceId>` (the registration barrier's freeze/reopen CAS + the provisioner create) and the
   *  serving ledger family `epcred.<endpoint>.<instanceId>.>` (the mint fence's stage + the barrier's
   *  revoke). REQUIRED for that profile. Every key is DERIVED inside the profile from
   *  (endpoint, instanceId) — none is a caller literal — so the manager drives the gate CAS + serve
   *  mint through THIS scoped executor and nothing else (critic #1: the manager-specific "no seed
   *  shortcut"; the standing seed connection never writes the epgate or the epcred family). Ignored
   *  by every other profile. */
  endpointServeExecutor?: { endpoint: string; instanceId: string };
  /** `goal-writer` profile only (P2 item 2, spawn-as-action): the endpoint whose action goals this
   *  standing connection may bind + commit ({@link goalWriterGrants}). REQUIRED for that profile;
   *  ignored by every other. */
  goalWriter?: { endpoint: string };
  /** `session-caller` profile only (P2 item 6): the ONE §13.6 session whose two eps rails this
   *  credential may use — the serving endpoint, the fresh sessionId, and the serving epoch. REQUIRED
   *  for that profile; ignored by every other. The rows pin all three, so the cred authorizes
   *  exactly that session's `in`+`out` and nothing else. */
  sessionCaller?: { endpoint: string; sessionId: string; epoch: number };
  /** `session-serving` profile only (P2 item 6): the ONE §13.6 session this SERVING credential may
   *  serve — same three coordinates as {@link sessionCaller}, with the rail directions swapped.
   *  REQUIRED for that profile; ignored by every other. The `session-ledger` profile takes no pin
   *  at all: it holds no rail, so it has nothing to pin. */
  sessionServing?: { endpoint: string; sessionId: string; epoch: number };
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
  /** `backup` profile only: one discriminated inspector or snapshot phase. */
  backup?: BackupPermissionScope;
  /** `restore` profile only: one discriminated initiate, upload, validate, or checkpoint phase. */
  restore?: RestorePermissionScope;
}

/** Compute a minted credential's `{ exp? }` from an explicit override or the centralized matrix
 *  default. Widened to {@link CredentialKind} (not just {@link Profile}) so the bespoke $SYS minters
 *  — `membership-observer` / `connection-evictor`, which are kinds, not profiles — thread the same
 *  bounded-lifetime policy instead of minting non-expiring $SYS creds. */
function userValidDates(kind: CredentialKind, opts: MintOpts): { exp?: number } {
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

/** Options for {@link provisionAgent} — {@link MintOpts} plus the active read set. */
export interface ProvisionOpts extends MintOpts {
  /** The active read set: the channels the agent subscribes to (live core-sub) at boot, and whose
   *  `durable`-class ones the agent self-joins for a Plane-3 backstop at connect (via the delivery
   *  daemon). Must be ⊆ `allowSubscribe`. Defaults to `["general"]`. */
  subscribe?: string[];
  /** Record this agent's read ACL so it can participate in durable delivery (default true). A durable
   *  backstop needs the agent's read ACL in the registry — the server-side delivery daemon re-authorizes
   *  every durable entry against it — written here at provision. Set FALSE for a LIVE-ONLY launcher
   *  (e.g. a direct foreground `cotal spawn` with no durable intent): no ACL row is written, so the daemon
   *  refuses to authorize a durable backstop and the agent stays live-only. Boot durable MEMBERSHIP itself
   *  is not written here — the agent self-joins its durable channels via the daemon's `ctl.delivery` op at
   *  connect. */
  durableMembership?: boolean;
}

/** The privileged onboarding ops a launcher needs at spawn — implemented by a connected, permissive
 *  endpoint (the manager at `cotal start`/`cotal up`, or a short-lived provisioner that `cotal spawn`
 *  opens). It pre-creates the agent's own mailboxes and records its read ACL; it does NOT host Plane-3
 *  delivery (that is the server-side delivery daemon). */
export interface DurableProvisioner {
  /** Pre-create the lifecycle's bind-only DM durable (`dm_<owner>-<actor>-<uid>`). The implementation
   *  captures the DM stream's ACTIVATION FRONTIER (its `last_seq` at first creation) and starts
   *  delivery at frontier+1 (SPEC §8) — a same-alias successor inherits no predecessor DMs.
   *  Idempotent PER LIFECYCLE: a re-provision of the same uid keeps the existing durable (and so the
   *  ORIGINAL frontier — the activation moment does not move on manager restart). */
  provisionDmInbox(owner: string, actor: string, lifecycleUid: string): Promise<void>;
  /** Pre-create the lifecycle's bind-only Plane-3 DELIVER durable (`dlv_<owner>-<actor>-<uid>`,
   *  filtered to the lifecycle-scoped `dlv.<owner>.<actor>.<uid>`) so it can BIND its per-member
   *  durable handoff without holding CONSUMER.CREATE on the DLV stream. */
  provisionDlvInbox(owner: string, actor: string, lifecycleUid: string): Promise<void>;
  /** Record the lifecycle's read ACL (`allowSubscribe`) in the durable ACL registry, keyed
   *  `<owner>.<actor>.<lifecycleUid>` (SPEC §13.1) — the same act as baking it into the JWT, persisted
   *  so the **server-side delivery daemon** can re-authorize the agent's durable entries and validate
   *  its runtime durable-joins (it holds no in-memory ledger). Replaces the old manager-written boot
   *  membership: boot durable membership is now the agent SELF-JOINING its durable channels via the
   *  daemon's `ctl.delivery` op at connect. */
  commitAcl(principal: string, lifecycleUid: string, allowSubscribe: string[]): Promise<void>;
  /**
   * Raise the mint-time ceiling. Only the provisioning path that also remints the JWT.
   * Process discipline, not crypto binding — see {@link reissueAcl}.
   */
  reissueAcl(principal: string, lifecycleUid: string, allowSubscribe: string[]): Promise<void>;
  provisionTaskQueue(role: string): Promise<void>;
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

/** Onboard an agent for launch (auth mode): pre-create its bind-only DM (+ Plane-3 DELIVER + role
 *  TASK) durables, RECORD its read ACL in the durable registry (unless `durableMembership:false`), and
 *  mint its scoped creds. Live delivery is the agent's own core subscription — there is no per-instance
 *  chat durable. Boot durable MEMBERSHIP is not written here: the agent self-joins its durable channels
 *  via the server-side delivery daemon's `ctl.delivery` op at connect. A deliberately live-only
 *  launcher (`durableMembership:false`, e.g. `cotal spawn --live-only`) gets no ACL row, so the
 *  daemon never authorizes a durable backstop for it. */
export async function provisionAgent(
  provisioner: DurableProvisioner,
  auth: SpaceAuth,
  identity: Identity,
  opts: ProvisionOpts = {},
): Promise<string> {
  if (!opts.lifecycleUid)
    throw new Error("provisionAgent: a lifecycleUid is required - the agent's broker footprint is lifecycle-keyed (SPEC 13.1); mint one with mintLifecycleUid() and persist it with the agent");
  const pr = principalOf(identity, opts.principal, opts.lifecycleUid);
  const allowSubscribe = await provisionAgentDurables(
    provisioner,
    { owner: pr.owner, actor: pr.actor, lifecycleUid: opts.lifecycleUid },
    opts,
  );
  return mintCreds(auth, identity, "agent", { ...opts, allowSubscribe });
}

/** The DURABLE half of agent onboarding, principal-keyed and credential-agnostic: pre-create the
 *  bind-only DM + DELIVER durables, record the read ACL, ensure the role TASK queue. The static
 *  path ({@link provisionAgent}) follows it with a mint; the USER-MODE spawn path runs it alone —
 *  a user agent's credential is its bearer (callout-minted per connect), never a static cred.
 *  Returns the resolved read ACL so both callers scope from the same computed set. */
export async function provisionAgentDurables(
  provisioner: DurableProvisioner,
  pr: { owner: string; actor: string; lifecycleUid: string },
  opts: ProvisionOpts = {},
): Promise<string[]> {
  const uid = assertLifecycleToken(pr.lifecycleUid); // hard cut: every provisioned footprint is lifecycle-keyed (SPEC 13.1)
  const subscribe = opts.subscribe?.length ? opts.subscribe : ["general"];
  const allowSubscribe = opts.allowSubscribe?.length ? opts.allowSubscribe : subscribe;
  // Reject channel names the wire layer would rewrite (the pre-created filter rides token() too).
  for (const ch of [...subscribe, ...allowSubscribe]) assertValidChannel(ch);
  // Re-assert the load-time invariant at the trust boundary (defense in depth): the pre-created
  // live filter (subscribe) must sit within the read ACL (allowSubscribe), or the provisioner
  // would hand the agent live delivery it isn't permitted to read.
  for (const ch of subscribe)
    if (!channelInAllow(allowSubscribe, ch))
      throw new Error(
        `provisionAgent: subscribe "${ch}" is not within allowSubscribe [${allowSubscribe.join(", ")}]`,
      );
  await provisioner.provisionDmInbox(pr.owner, pr.actor, uid);
  await provisioner.provisionDlvInbox(pr.owner, pr.actor, uid);
  // Record the agent's read ACL in the durable registry (the same act as baking it into the JWT) so the
  // server-side delivery daemon can re-authorize this agent's durable entries + validate its runtime
  // durable-joins — it holds no in-memory ledger. The agent SELF-JOINS its durable boot channels via the
  // daemon at connect (no manager-written boot membership). `durableMembership:false` (an explicit
  // live-only launcher, e.g. `cotal spawn --live-only`) opts out of the ACL row → the daemon never
  // authorizes a durable backstop for it, so it stays live-only.
  // ACL is keyed by the lifecycle-scoped dot-form <owner>.<actor>.<uid> (per-incarnation read authority).
  // reissueAcl — rides THIS mint: allowSubscribe was just baked into the user JWT above. Separate
  // from commitAcl so an ordinary registry writer cannot raise the ceiling by passing a flag
  // (SPEC §9.6). Not crypto-bound to the JWT bytes — process discipline that this call stays next
  // to the mint (ACL-authority panel residual).
  if (opts.durableMembership !== false) {
    await provisioner.reissueAcl(principalKey(pr.owner, pr.actor).key, uid, allowSubscribe);
  }
  if (opts.role) await provisioner.provisionTaskQueue(opts.role);
  return allowSubscribe;
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
  const signer = fromSeed(new TextEncoder().encode(auth.account.signingSeed));
  const pr = principalOf(identity, opts.principal, opts.lifecycleUid);
  // Serve rows are INTERNAL to mintCreds behind the §13.1 fence: the exported permissionsFor
  // refuses "endpoint-serve" (so a direct caller can never obtain unfenced serve rows), and only
  // this fenced path calls the row builder.
  const perms = profile === "endpoint-serve"
    ? endpointServePermissions(auth.space, pr, opts)
    : permissionsFor(profile, auth.space, pr, opts);
  const validDates = userValidDates(profile, opts);
  const userJwt = await encodeUser(
    profile,
    fromPublic(identity.id),
    fromPublic(auth.account.pub),
    // Stamp the principal `tags` so this connection's identity is CONNZ-recoverable by the membership
    // feed — the SAME tags the auth callout stamps (user mode), via core's single-source builder. The
    // JWT `name` stays the profile label (a debug breadcrumb; not a surfaced/queryable CONNZ field).
    { ...perms, tags: principalTags(pr.owner, pr.actor) },
    { signer, ...validDates },
  );
  // Build the credential string FULLY before the fence: nothing fallible may run AFTER a winning
  // CAS, or a post-CAS throw would leave a committed ledger row with no released credential (an
  // orphan authority record). fmtCreds only wraps the already-signed JWT with the seed, so it is
  // done here and the fence is the mint's LAST step.
  const creds = new TextDecoder().decode(fmtCreds(userJwt, fromSeed(new TextEncoder().encode(identity.seed))));
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
      // PER-ISSUED-JWT id (digest of the credential): every issuance (a standing renewal included)
      // has distinct bytes (fresh exp/iat), so it writes a DISTINCT ledger row and never overwrites
      // or resurrects a prior one. The create-only / idempotent-if-identical guarantee lives at the
      // finalize/stage seam (the SAME credential object staged twice), not the mint layer. The
      // stable nkey rides separately as `credentialKey` for broker revocation. KEY-SAFE digest
      // form (`sha256-<hex>`, never the §13.7 `sha256:` artifact form): the id becomes a segment
      // of the durable `epcred.` KV key, whose grammar has no ":" — the digest property (a
      // byte-identical retry maps to the SAME id) is what matters, not the separator.
      credentialId: rawDigest(creds).replace("sha256:", "sha256-"),
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

/** Build the NATS user permission object for a profile: a default-deny allow-list scoped to
 *  exactly what each profile does. Every profile is now enumerated least-privilege — the former
 *  allow-all `manager` is gone (its roles split across supervisor/provisioner/operator/purger and the
 *  PR 1.5 CLI-surface profiles). Subject/stream/durable names come from the shared builders so the ACLs
 *  can't drift from the wire layout.
 *
 *  PRINCIPAL-PARAMETERIZED + MODE-AGNOSTIC (owner+actor grammar): `pr` carries the owner+actor wire
 *  principal (chat/inst/svc/ctl subjects, per-agent durables, the presence key all scope to it) PLUS the
 *  connection nkey (`pr.connId`, which scopes the private reply inbox `_INBOX_<connId>`). Core does NOT
 *  fork on dev-vs-user — the composition root supplies the principal: the auth callout passes the derived
 *  owner + ledger actor + the per-connection ephemeral nkey; the static/dev mint passes
 *  `{owner:"local", actor:<id>, connId:<id>}` via {@link principalOf}. EXPORTED so the callout's injected
 *  `permissionsFor` hook can feed a validated principal straight into the same builder. */
export function permissionsFor(
  profile: Profile,
  space: string,
  pr: MintPrincipal,
  opts: MintOpts,
): Record<string, unknown> {
  // Guard the connId BEFORE any profile builds `_INBOX_<connId>.>`: in user mode connId is a client-
  // chosen nonce (untrusted), so a metacharacter here would escalate the inbox grant to every inbox.
  // Assert once, for all profiles (each early-returning profile builds its own inbox from pr.connId).
  assertInboxConnId(pr.connId);
  // Extraneous serve-artifact refusal, hoisted ABOVE the profile dispatch: every early-return
  // profile (delivery/supervisor/observer/...) must refuse it too, not just the agent tail, or a
  // misconfigured sensitive mint is silently masked (MintOpts: every other profile refuses it).
  // The "endpoint-serve" profile is excluded so its own arm below keeps the call-mintCreds redirect.
  if (opts.endpointServe && profile !== "endpoint-serve")
    throw new Error(`permissionsFor: endpointServe rides the dedicated "endpoint-serve" profile - a serve credential is per-instance authority (SPEC 13.9), never folded into a "${profile}" cred`);
  if (profile === "delivery") return deliveryPermissions(space, pr); // scoped server-side Plane-3 infra
  if (profile === "membership-rw") return membershipRwPermissions(space, pr); // scoped graph-feed reader/writer
  if (profile === "supervisor") return supervisorPermissions(space, pr); // always-on daemon (closure (ii) gate)
  if (profile === "provisioner") return provisionerPermissions(space, pr); // ephemeral onboarding authority (closure (ii))
  if (profile === "deprovisioner") {
    // Ephemeral, TARGET-PINNED teardown (#159 B) — the counterpart to `provisioner`. The target is a
    // full principal dot-form for user-mode agents, or a bare static/dev actor id (keyed under
    // DEV_OWNER) — see {@link deprovisionTargetPrincipal}.
    if (!opts.deprovisionTarget)
      throw new Error("permissionsFor: deprovisioner requires opts.deprovisionTarget ({principal, lifecycleUid} of the departed incarnation)");
    return deprovisionerPermissions(space, pr, opts.deprovisionTarget);
  }
  if (profile === "retirement-requester") {
    // Ephemeral request+reply on the AUTH ENDPOINT rail (#29 piece 3; moved off `ctl` by #350):
    // publish EXACTLY this caller triple's own request subject for the ONE target it names +
    // subscribe its own reply-plane filter and inbox. No store reads, no barrier/scanner/plane
    // authority - the requester only asks; the auth plane holds every executing right and
    // re-checks the serve registration at serve time.
    // Validate the WHOLE shape, not just its presence. Each of these is a subject token: a missing
    // one would otherwise surface as a raw "cannot read properties of undefined" from deep inside
    // the subject builder, which tells the operator nothing about WHICH field it owes. The `target`
    // arrived with #350 (the handle triple moved into the subject), so a caller written against the
    // pre-#350 `{owner, actor}` shape lands here — and must be told exactly that.
    const rr = opts.retirementRequester;
    if (!rr)
      throw new Error("permissionsFor: retirement-requester requires opts.retirementRequester ({owner, actor, uid, target} of the requesting manager)");
    for (const [k, v] of [["owner", rr.owner], ["actor", rr.actor], ["uid", rr.uid]] as const)
      if (typeof v !== "string" || v.length === 0)
        throw new Error(`permissionsFor: retirement-requester requires opts.retirementRequester.${k} (the caller triple is <owner>.<actor>.<uid>; since #350 the rail carries the CALLER's uid, not a two-token alias)`);
    if (!rr.target || typeof rr.target.owner !== "string" || typeof rr.target.actor !== "string" || typeof rr.target.lifecycleUid !== "string")
      throw new Error("permissionsFor: retirement-requester requires opts.retirementRequester.target ({owner, actor, lifecycleUid} of the ONE incarnation this credential may retire) - since #350 the handle target rides the SUBJECT and is grant-pinned, so it can no longer be supplied in the request body");
    const { owner, actor, uid, target } = rr;
    const caller = { owner, actor, uid };
    // DEVIATION FROM `handle`'s NORMATIVE PROVENANCE, stated where the row is minted (SPEC
    // 1314-1319, 1838-1863). `handle` is normatively REDEMPTION-MINTED: its triple is pinned at
    // redemption from an ISSUER-SIGNED capability artifact, and the mode carries attenuation
    // (`effective = presenter-cred INTERSECT handle.grants INTERSECT issuer-authority`), conferral
    // through the trusted auth service, and ledgered `sourceChain` lineage.
    // THIS PATH HAS NONE OF THAT: there is NO issuer-signed artifact, NO redemption step and NO
    // sourceChain. The row is built directly from the manager's own coordinates under root
    // authority. It is used because `handle` is the ONLY mode with arity 3 - every other mode
    // resolves against the CURRENT mapping, which is the wrong semantics for retiring a NAMED
    // incarnation - and because the reader-facing invariant ("the validator re-checks only
    // currency") IS honoured: the auth handler fresh-checks the triple against the lifecycle
    // mapping and refuses a stale incarnation.
    // What is genuinely absent is delegation lineage and artifact revocation. There is no
    // independent issuer/holder boundary on this one-shot path whose revocation would change this
    // requester's authority, which is why the deviation is accepted rather than papered over with
    // a manufactured artifact. NAMED RESIDUAL: Cotal #399 tracks making this genuinely
    // redemption-shaped if real artifact semantics are ever intended.
    // The `handle` target is grant-pinned, so this credential can ask to retire the ONE
    // incarnation it was minted for and nothing else - the same confinement the pre-#350 grant got
    // from naming an exact `ctl` subject, now covering the TARGET as well as the caller. The nonce
    // is the only wildcard token (§13.9): a bounded per-request suffix, not an addressing widening.
    const rows = epRequestGrantRows(space, {
      endpoint: AUTH_ENDPOINT,
      command: EP_CMD_RETIRE_LIFECYCLE,
      target: { mode: "handle", tOwner: target.owner, tActor: target.actor, tUid: target.lifecycleUid },
    }, caller);
    return { pub: { allow: rows }, sub: { allow: [epCallerReplyFilter(space, caller), `_INBOX_${pr.connId}.>`] } };
  }
  if (profile === "endpoint-evictor") {
    // P2 item 3 (slice 3a): a SCOPED delivery-admin caller for ONE re-registration's verify-evict.
    // Publish EXACTLY this credential's OWN delivery-admin control subject + $JS.API.INFO; subscribe
    // its own reply subtree + inbox. NO lease, presence, store read, consumer, KV, or executing
    // right — the daemon does the $SYS scan/KICK (subject-gated authority, like the supervisor evictor
    // it narrows) and the manager passes only the predecessor's principal. Narrower than the
    // `supervisor` profile the auth barrier-evict reuses (its #30 residual, done here for the manager).
    const req = controlServiceSubject(space, CONTROL_DELIVERY_ADMIN, pr.owner, pr.actor);
    return { pub: { allow: [req, "$JS.API.INFO"] }, sub: { allow: [`${req}.reply.>`, `_INBOX_${pr.connId}.>`] } };
  }
  if (profile === "lifecycle-executor") {
    if (!opts.lifecycleExecutor)
      throw new Error("permissionsFor: lifecycle-executor requires opts.lifecycleExecutor ({owner, actor, lifecycleUid, alias} of the ONE incarnation it may move)");
    return lifecycleExecutorPermissions(space, pr, opts.lifecycleExecutor);
  }
  if (profile === "endpoint-serve-executor") {
    if (!opts.endpointServeExecutor)
      throw new Error("permissionsFor: endpoint-serve-executor requires opts.endpointServeExecutor ({endpoint, instanceId} of the ONE endpoint instance it may register/serve-mint)");
    return endpointServeExecutorPermissions(space, pr, opts.endpointServeExecutor);
  }
  if (profile === "goal-writer") {
    if (!opts.goalWriter)
      throw new Error("permissionsFor: goal-writer requires opts.goalWriter ({endpoint} whose action goals this connection binds + commits)");
    return goalWriterPermissions(space, pr, opts.goalWriter);
  }
  if (profile === "purger") return purgerPermissions(space, pr); // ephemeral history-purge (closure (ii))
  if (profile === "backup") {
    if (!opts.backup) throw new Error("permissionsFor: backup requires opts.backup");
    return backupProfilePermissions(space, pr.connId, opts.backup);
  }
  if (profile === "restore") {
    if (!opts.restore) throw new Error("permissionsFor: restore requires opts.restore");
    return restoreProfilePermissions(space, pr.connId, opts.restore);
  }
  if (profile === "operator") return operatorPermissions(space, pr); // human-CLI client (send/dm/ask) (closure (ii))
  if (profile === "probe") return probePermissions(pr); // connect-only liveness/auth preflight (PR 1.5)
  if (profile === "channel-writer") return channelWriterPermissions(space, pr); // channel-registry writes (PR 1.5)
  if (profile === "channel-purger") return channelPurgerPermissions(space, pr); // channel-writer + CHAT purge (PR 1.5)
  if (profile === "teardown") return teardownPermissions(space, pr); // sole STREAM.DELETE holder (PR 1.5)
  if (profile === "control-caller-privileged") return controlCallerPermissions(space, pr, "privileged", opts); // ps/start reads (PR 1.5)
  if (profile === "control-caller-admin") return controlCallerPermissions(space, pr, "admin", opts); // any-mode stop/attach (PR 1.5)
  if (profile === "deployer") return deployerPermissions(space, pr, opts.controlTier ?? "admin", opts); // spawn -f deploy authority (PR 1.5; user-mode view rides privileged)
  if (profile === "session-caller") return sessionCallerPermissions(space, pr, opts.sessionCaller); // one §13.6 session's caller rails (P2 item 6)
  if (profile === "session-serving") return sessionServingPermissions(space, pr, opts.sessionServing); // one §13.6 session's SERVING rails (P2 item 6)
  if (profile === "session-ledger") return sessionLedgerPermissions(space, pr); // the dedicated session ledger, no rails (P2 item 6)
  if (profile === "endpoint-serve")
    // Serve rows are emitted ONLY by mintCreds behind the §13.1 issuance fence — never via this
    // exported builder, so a direct signer/callout can't obtain unfenced serve rows (SPEC 13.1/13.9).
    throw new Error("permissionsFor: endpoint-serve rows are emitted only by mintCreds behind the §13.1 issuance fence; call mintCreds");
  const CHAT = chatStream(space), DM = dmStream(space), TASK = taskStream(space);
  const KV = `KV_${presenceBucket(space)}`;
  const CHKV = `KV_${channelBucket(space)}`; // channel registry (read-only for everyone)
  const MEMKV = `KV_${membershipBucket(space)}`; // derived graph membership feed (read-only — dashboard)
  const DLVKV = `KV_${deliveryBucket(space)}`; // delivery lease/readiness (read-only — Component 6 health)
  // Wire identity: owner+actor for subjects/durables/presence (dot-form `pk.key`, name-form `pk.name`);
  // the reply inbox keys on the CONNECTION nkey, not the principal (see MintPrincipal).
  const pk = principalKey(pr.owner, pr.actor);
  const inbox = `_INBOX_${pr.connId}.>`;

  if (profile === "observer" || profile === "admin") {
    // Read-only: live feed via tap, history + presence via ephemeral/ordered consumers it
    // creates on CHAT + the presence KV. No chat/inst/svc/ctl publish → can't post.
    //   observer — sub chat.> only; DM_<space>/svc never named → DMs + anycast structurally
    //     invisible (step-6 inbox scoping means it can't sniff deliveries either).
    //   admin — sub widened to the MESSAGING plane, enumerated (SPEC 13.9/13.11): the
    //     dashboard's tap also sees DMs (inst.>) and anycast (svc.>) live, PLUS DM-stream read
    //     verbs so it can backfill DM history. A deliberate god-view over messaging only: a
    //     space-wide `>` would additionally plain-subscribe every v0.4 endpoint request rail
    //     (collecting the reply nonces the queue-qualified-only rule protects) and every
    //     core-only session frame, so the ep/epe/epf/epj/ept/epr/epw/eps/epc planes are
    //     deliberately excluded. DMs are plaintext + ACL-gated, so mint this only for a
    //     trusted audit dashboard. CONSUMER.CREATE on DM_<space> is the DM-confidentiality
    //     surface — granted here ONLY for this elevated read-only profile, never to agents.
    const sub =
      profile === "admin"
        ? [`${spacePrefix(space)}.chat.>`, `${spacePrefix(space)}.inst.>`, `${spacePrefix(space)}.svc.>`, inbox]
        : [`${spacePrefix(space)}.chat.>`, inbox];
    const allow = [
      "$JS.API.INFO",
      `$JS.API.STREAM.INFO.${CHAT}`,
      `$JS.API.STREAM.INFO.${KV}`,
      // ephemeral backlog consumer (channelHistory): a multi-filter create can't encode its
      // filter in the subject → bare form; the .> form covers named consumers.
      `$JS.API.CONSUMER.CREATE.${CHAT}`,
      `$JS.API.CONSUMER.CREATE.${CHAT}.>`,
      `$JS.API.CONSUMER.INFO.${CHAT}.>`,
      `$JS.API.CONSUMER.MSG.NEXT.${CHAT}.>`,
      `$JS.API.CONSUMER.DELETE.${CHAT}.>`,
      `$JS.ACK.${CHAT}.>`,
      `$JS.API.CONSUMER.CREATE.${KV}.>`, // kv.watch ordered consumer (roster is public)
      `$JS.API.CONSUMER.INFO.${KV}.>`,
      // Channel registry read (watch + direct kv.get + enriched listChannels) — config is
      // world-readable. STREAM.MSG.GET is the verb kv.get() rides (the bucket has no allow_direct).
      `$JS.API.STREAM.INFO.${CHKV}`,
      `$JS.API.STREAM.MSG.GET.${CHKV}`,
      `$JS.API.CONSUMER.CREATE.${CHKV}.>`,
      `$JS.API.CONSUMER.INFO.${CHKV}.>`,
      `$JS.API.CONSUMER.DELETE.${CHKV}.>`,  // ephemeral consumer cleanup
      // Derived graph-membership feed (broker-sourced who-is-subscribed) — watch + direct kv.get. The
      // silent-reader set is sensitive, so read is admin/observer-only (this elevated profile), never an
      // agent. Read-only: no `$KV.${membershipBucket}` publish — only the `membership-rw` cred writes it.
      `$JS.API.STREAM.INFO.${MEMKV}`,
      `$JS.API.STREAM.MSG.GET.${MEMKV}`,
      `$JS.API.CONSUMER.CREATE.${MEMKV}.>`,
      `$JS.API.CONSUMER.INFO.${MEMKV}.>`,
      `$JS.API.CONSUMER.DELETE.${MEMKV}.>`,
      "$JS.FC.>", // ordered-consumer flow control
    ];
    if (profile === "admin") {
      // DM history backfill (dmHistory): same bare-form gotcha as CHAT — filter_subjects is
      // plural so the create lands on the bare subject; the .> form covers named consumers.
      allow.push(
        `$JS.API.STREAM.INFO.${DM}`,
        `$JS.API.CONSUMER.CREATE.${DM}`,
        `$JS.API.CONSUMER.CREATE.${DM}.>`,
        `$JS.API.CONSUMER.INFO.${DM}.>`,
        `$JS.API.CONSUMER.MSG.NEXT.${DM}.>`,
        `$JS.API.CONSUMER.DELETE.${DM}.>`,
        `$JS.ACK.${DM}.>`,
      );
    }
    return { sub: { allow: sub }, pub: { allow } };
  }

  // ---- agent ----
  // No silent fallthrough: every non-agent profile is handled above, so anything else reaching here is a
  // stale/unwired profile string (e.g. a JS caller bypassing the closed `Profile` union). Fail loud rather
  // than mint it agent perms by accident (the no-fallbacks rule; matches the deleted `manager`'s intent).
  if (profile !== "agent")
    throw new Error(`permissionsFor: unhandled profile "${profile}" - add an explicit arm, do not fall through to agent`);
  const allowPublish = opts.allowPublish ?? []; // post ACL — DEFAULT-DENY (publish must be declared)
  const allowSubscribe = opts.allowSubscribe?.length ? opts.allowSubscribe : ["general"]; // read ACL
  // Re-assert at the mint chokepoint (covers mint/spawn paths that bypass the file loader): a policy
  // channel must equal its wire token, or the minted grant would alias the logical ACL.
  for (const ch of [...allowSubscribe, ...allowPublish]) assertValidChannel(ch);
  if (!pr.lifecycleUid)
    throw new Error("permissionsFor(agent): a lifecycleUid is required - the agent's dm/dlv/chathist grants are lifecycle-keyed exact names (SPEC 13.1)");
  const uid = assertLifecycleToken(pr.lifecycleUid);
  const chatHistD = chatHistDurable(pr.owner, pr.actor, uid), dmD = dmDurable(pr.owner, pr.actor, uid);
  const DLV = dlvStream(space), dlvD = dlvDurable(pr.owner, pr.actor, uid); // Plane-3 per-member delivery (bind-only)
  const svcD = opts.role ? taskDurable(opts.role) : undefined;
  const pubAllow = [
    // peer publish — owner+actor identity + channel scope, built from the real builders. Default-deny:
    // ONLY the declared allowPublish channels (none by default) get a chat-publish grant.
    ...allowPublish.map((ch) => chatSubject(space, pr.owner, pr.actor, ch)),
    unicastSubject(space, "*", "*", pr.owner, pr.actor), // inst.*.*.<o>.<a> — DM any instance, as me
    anycastSubject(space, "*", pr.owner, pr.actor), //  svc.*.<o>.<a>   — anycast any role, as me
    // Self stop/despawn rides the v0.4 ep baseline (`stop` self-mode) — the manager `ctl` rail is
    // deleted (1d). The delivery-daemon rail below is a separate service (Plane-3), kept.
    // ctl.delivery.<o>.<a> — request a durable backstop join/leave/list from the SERVER-SIDE delivery
    // daemon (NOT the manager). The reply rides this same subtree (`ctl.delivery.<o>.<a>.reply.<n>`, in
    // sub.allow below) so the daemon can answer without broad inbox-publish — see CONTROL_DELIVERY.
    controlServiceSubject(space, CONTROL_DELIVERY, pr.owner, pr.actor),
    // JetStream control plane — scoped to this agent's own streams/durables.
    "$JS.API.INFO",
    // STREAM.INFO: CHAT (join watermark, recall drop-marker, channel-list counts — a documented
    // metadata surface, see SPEC §9) + the world-readable presence/registry KVs. NOT DM/TASK: agents
    // bind their dm_<id>/svc_<role> by name and never inspect those streams, so granting INFO there
    // would only leak DM-inbox / task subject metadata across peers for no functional gain.
    `$JS.API.STREAM.INFO.${CHAT}`, `$JS.API.STREAM.INFO.${KV}`, `$JS.API.STREAM.INFO.${CHKV}`,
    // Live channel delivery is the agent's own native core subscription (sub.allow over chat.*.<ch>,
    // below) — there is NO per-instance chat live-tail durable to bind. The durable backstop is
    // Plane-3 (the bind-only dlv_<id> durable below). So no CHAT consumer bind/ack grants here.
    // CHAT history reads (join-backfill, focus-recall, drop-marker) — single-filter EPHEMERAL
    // consumers named chathist_<id>. The create rides the extended subject
    // CONSUMER.CREATE.<CHAT>.<chathist_id>.<filter>, whose trailing filter token nats-server pins to
    // the request body (JSConsumerCreateFilterSubjectMismatchErr, code 10131) — so one create grant
    // per allowSubscribe channel makes history reads broker-bounded to the read ACL. Replaces the
    // old unfiltered DIRECT.GET.<CHAT> (which could fetch ANY message regardless of channel). The
    // name is the agent's own, so info/fetch/delete can't reach a peer's consumer. NO broad
    // CONSUMER.CREATE.<CHAT> / .> deny here: NATS deny beats allow, which would also kill these.
    ...allowSubscribe.map((ch) => `$JS.API.CONSUMER.CREATE.${CHAT}.${chatHistD}.${chatSubject(space, "*", "*", ch)}`),
    `$JS.API.CONSUMER.INFO.${CHAT}.${chatHistD}`,
    `$JS.API.CONSUMER.MSG.NEXT.${CHAT}.${chatHistD}`,
    `$JS.API.CONSUMER.DELETE.${CHAT}.${chatHistD}`,
    // DM consumer: BIND ONLY — info/fetch/ack its own pre-created durable, never create.
    `$JS.API.CONSUMER.INFO.${DM}.${dmD}`,
    `$JS.API.CONSUMER.MSG.NEXT.${DM}.${dmD}`,
    `$JS.ACK.${DM}.${dmD}.>`,
    // Plane-3 DELIVER consumer (SPEC §8): BIND ONLY its own pre-created dlv_<id> — info/fetch/ack,
    // never create (the provisioner pre-creates it filtered to dlv.<id>). The agent acks this via
    // native JetStream — the re-authorized per-member handoff. It gets NO grant on the INBOX (mixed
    // pre-auth) stream at all: default-deny keeps the fan-out target unreadable by the agent.
    `$JS.API.CONSUMER.INFO.${DLV}.${dlvD}`,
    `$JS.API.CONSUMER.MSG.NEXT.${DLV}.${dlvD}`,
    `$JS.ACK.${DLV}.${dlvD}.>`,
    // Presence: watch (read, public roster) + flow control + PUT OWN KEY ONLY.
    `$JS.API.CONSUMER.CREATE.${KV}.>`,
    `$JS.API.CONSUMER.INFO.${KV}.>`,
    "$JS.FC.>",
    `$KV.${presenceBucket(space)}.${pk.key}`, // own presence key (owner+actor) only — can't spoof peers
    // Channel registry: read-only (watch + direct kv.get for the join-time replay decision).
    // No `$KV.${channelBucket(space)}.*` publish — privileged-write, default-deny gives that free.
    `$JS.API.STREAM.MSG.GET.${CHKV}`,
    `$JS.API.CONSUMER.CREATE.${CHKV}.>`,
    `$JS.API.CONSUMER.INFO.${CHKV}.>`,
    // Delivery lease/readiness: READ-ONLY (kv.get) for the non-gating `cotal_channels` delivery-health
    // surface (Component 6). The lease key is daemon-availability info, like the world-readable roster;
    // NO write grant — only the `delivery` cred writes it.
    `$JS.API.STREAM.INFO.${DLVKV}`,
    `$JS.API.STREAM.MSG.GET.${DLVKV}`,
    // Manager singleton lease (`cotal_manager_<space>`): NO grant at all — an agent must never read,
    // write, or delete it. The manager (allow-all) is its only writer; an agent that could mutate the
    // lease key could DoS the supervisor (evict it / pre-create the key to block a fresh one). Safety is
    // by OMISSION (default-deny on the un-granted `KV_cotal_manager_*` stream + `$KV.cotal_manager_*.>`),
    // so do NOT add a broad `KV_*` / `$KV.<space>.>` grant that would silently re-open it.
  ];
  if (svcD) {
    // TASK consumer: BIND ONLY its own role's pre-created durable (svc_<role>). Like DM, the
    // create-time filter_subject isn't reliably ACL-constrainable, so no create path is
    // allowed — the privileged provisioner pre-creates svc_<role> filtered to svc.<role>.*.
    pubAllow.push(
      `$JS.API.CONSUMER.INFO.${TASK}.${svcD}`,
      `$JS.API.CONSUMER.MSG.NEXT.${TASK}.${svcD}`,
      `$JS.ACK.${TASK}.${svcD}.>`,
    );
  }
  // Spawn / admin capability control reach rides the v0.4 ep rows below (the manager `ctl` rail is
  // deleted, 1d) — the spawn set (owner-mode manager lifecycle) and the admin instrument set
  // (any-mode + manager.admin family) are added to the ep caller rows, not a ctl subject.
  // v0.4 endpoint rails (SPEC §13.9 caller rows). EVERY agent gets the Appendix-B BASELINE set
  // (wildcard describe + delivery join/leave/list + self-mode lifecycle + the reply rail), keyed
  // on the SAME lifecycle uid as the agent's durables; the spawn capability adds the owner-mode
  // manager lifecycle set. Beyond the baseline stays default-deny: only minted capabilities
  // produce rows, each pinning the full caller triple (§13.1 lifecycle UID included; the nonce
  // is the only wildcard token).
  // ONE lifecycle uid keys the whole caller rail (§13.1/§13.2 forge-lock: one credential names one
  // incarnation). `uid` is the already-asserted pr.lifecycleUid; the baseline, the spawn set, AND
  // the explicit capabilities ALL build their caller triple from it. opts.lifecycleUid is a public
  // seam (the IdP-adapter path) that must AGREE, never a second source of truth for the triple: a
  // divergent value would mint two reply rails on one credential, so it fails loud here.
  const epCaller = { owner: pr.owner, actor: pr.actor, uid };
  const baseline = epBaselineGrantRows(space, epCaller);
  pubAllow.push(...baseline.pub);
  const epSub: string[] = [...baseline.sub];
  // BOTH HALVES OF THE ROLLUP, NOT JUST `pub`. `epCallerGrantRows` returns `{pub, sub}` and its
  // `sub` is the per-goal progress row its own docblock promises: "a goal-bearing capability
  // (spawn/launch) adds ONE per-endpoint epGoalProgressGrantRow - the caller may follow its OWN
  // goal to terminal". Taking `.pub` alone minted a credential that may SUBMIT a goal and may not
  // HEAR it, so the broker refused the follow and the caller reported a timeout about a goal whose
  // terminal had already been committed (#610). `spawn` is goal-bearing, so this `sub` is never
  // empty here - the row was computed correctly and discarded one property access short of the
  // credential.
  if (opts.capabilities?.includes("spawn")) {
    const rows = epCallerGrantRows(space, spawnCallerCapabilities(pr.owner), epCaller);
    pubAllow.push(...rows.pub);
    for (const s of rows.sub) if (!epSub.includes(s)) epSub.push(s);
  }
  if (opts.capabilities?.includes("admin"))
    // The admin capability's ep mirror (the 1c grant-migration table): the v0.3 `ctl.<admin>`
    // subject above grants the FULL admin-tier op reach, so its holder gets the admin instrument
    // set on the ep rails — any-mode despawn/attach + the `manager.admin` family + the reads. In
    // user mode this is the ledger `admin` scope arriving via the callout, the broker-enforced
    // half of the tier; the manager's ledger-derived per-op admin flag stays on top of it.
    {
      // Same `{pub, sub}` contract as the spawn branch above: an admin instrument's set carries the
      // goal-bearing lifecycle commands, so it earns the same follow row.
      const rows = epCallerGrantRows(space, operatorInstrumentCapabilities("admin", pr.owner), epCaller);
      pubAllow.push(...rows.pub);
      for (const s of rows.sub) if (!epSub.includes(s)) epSub.push(s);
    }
  if (opts.endpointCapabilities?.length) {
    if (opts.lifecycleUid !== undefined && assertLifecycleToken(opts.lifecycleUid) !== uid)
      throw new Error(`permissionsFor: opts.lifecycleUid "${opts.lifecycleUid}" disagrees with the principal's lifecycleUid "${uid}" - one credential names ONE incarnation on the caller rail (SPEC 13.1/13.2)`);
    const rows = epCallerGrantRows(space, opts.endpointCapabilities, epCaller);
    pubAllow.push(...rows.pub);
    for (const s of rows.sub) if (!epSub.includes(s)) epSub.push(s);
  }
  // Explicit create-deny (defense-in-depth over default-deny) on the two streams whose
  // create-time filter_subject is the attack surface — DM (private content) and TASK
  // (cross-role work-stealing). Covers the bare ephemeral form (no trailing token), the
  // named/new-API form, and the old durable form. No create path on either stream.
  const pubDeny = [
    `$JS.API.CONSUMER.CREATE.${DM}`,
    `$JS.API.CONSUMER.CREATE.${DM}.>`,
    `$JS.API.CONSUMER.DURABLE.CREATE.${DM}.>`,
    `$JS.API.CONSUMER.CREATE.${TASK}`,
    `$JS.API.CONSUMER.CREATE.${TASK}.>`,
    `$JS.API.CONSUMER.DURABLE.CREATE.${TASK}.>`,
    // Plane-3 DELIVER: bind-only, like DM — the create-time filter_subject is the attack surface, so
    // no create path (the provisioner pre-creates dlv_<id> filtered to dlv.<id>).
    `$JS.API.CONSUMER.CREATE.${DLV}`,
    `$JS.API.CONSUMER.CREATE.${DLV}.>`,
    `$JS.API.CONSUMER.DURABLE.CREATE.${DLV}.>`,
  ];
  // CHAT live read boundary (SPEC v0.3 §9 / Appendix B): mint the read ACL as a native `sub.allow`
  // over cotal.<space>.chat.*.<channel> — one per allowSubscribe channel, wildcards passed through
  // (e.g. chat.*.review.>, chat.*.>). This is what lets an agent self-serve a live channel subscribe
  // with NO manager: join = nc.subscribe, broker-enforced per-subscribe, no consumer name to confine,
  // so an open ACL needs no enumeration. This sub.allow grant IS the live read path — there is no
  // per-instance chat durable; the durable backstop is Plane-3 (delivery-daemon fan-out → per-member DELIVER).
  const subChat = allowSubscribe.map((ch) => chatSubject(space, "*", "*", ch));
  // Replies to this agent's durable join/leave/list requests ride `ctl.delivery.<o>.<a>.>` (NOT the
  // per-id _INBOX), so the scoped delivery daemon can answer without broad inbox-publish.
  const deliveryReplies = `${controlServiceSubject(space, CONTROL_DELIVERY, pr.owner, pr.actor)}.>`;
  // Manager control replies ride the v0.4 ep reply rail (in `epSub`, keyed on the caller triple) —
  // the `ctl.<tier>.<id>.reply.>` subtrees are gone with the ctl rail (1d).
  return { pub: { allow: pubAllow, deny: pubDeny }, sub: { allow: [inbox, deliveryReplies, ...subChat, ...epSub] } };
}

/** The long-lived SUPERVISOR permission set (closure (ii), residual 2) — the always-on manager daemon
 *  (`manager.ts` `this.ep`), carved down from the former allow-all `manager`. THIS is the cred whose
 *  STANDING breadth was the residual-2 gate: tightening it removes the always-on DM/DLV body-read AND the
 *  stream-admin tamper from the one connection that never goes away. It does exactly three things — serve
 *  the three lifecycle control tiers (bounded replies), hold the singleton manager lease, and publish +
 *  watch presence (the roster) — and nothing else. Provisioning (DM/DLV/TASK consumer-create + ACL
 *  writes) moves to the EPHEMERAL `provisioner` (opened per-spawn); destructive history-purge moves to the
 *  EPHEMERAL `purger`. So the supervisor holds NO chat/inst/svc publish (it never posts — only
 *  `setActivity`, a presence write), NO DM/DLV read of any kind (no consumer-create, no native sub), NO
 *  stream CREATE/DELETE/PURGE/UPDATE, NO channel-registry access (the daemon sets `watchChannels:false`).
 *  `$JS` is an ENUMERATED allow-list — exactly the presence-watch + lease-KV verbs — never `$JS.>`. A
 *  leaked supervisor cred can hold the lease and read the public roster; it cannot read a DM, forge an
 *  actor, provision, purge, or tamper with a stream. */
function supervisorPermissions(space: string, pr: MintPrincipal): Record<string, unknown> {
  const PKV = `KV_${presenceBucket(space)}`, MKV = `KV_${managerBucket(space)}`;
  // 1d: the supervisor no longer serves the manager control tiers — the manager's control surface
  // is its v0.4 `service` endpoint, served on a SEPARATE connection under its own `endpoint-serve`
  // credential (its rails are that credential's grant, not the supervisor's). The supervisor now
  // holds only the lease, presence, and the ONE delivery-admin call.
  return {
    pub: {
      allow: [
        "$JS.API.INFO",
        // Per-instance manager liveness lease (managerBucket, pre-created at `cotal up`): OPEN-ONLY bind +
        // CAS this instance's own `lease.<instanceId>` key (acquire/renew/release) + read the subtree. P2
        // item 3 demoted the per-space singleton to per-instance keys, so the write grant spans `lease.*`
        // (every instance of this space shares this one supervisor principal — the isolation between
        // instances is the logical-id/CAS boundary, not a cred boundary). NO STREAM.CREATE (pre-created),
        // DELETE, or PURGE.
        `$JS.API.STREAM.INFO.${MKV}`,
        `$JS.API.STREAM.MSG.GET.${MKV}`, // readManagerLease (last_by_subj lease.*) + CAS-conflict kv.get
        `$KV.${managerBucket(space)}.${MANAGER_LEASE_KEY}.*`, // this instance's lease.<id> key (create/update/delete = $KV publishes)
        // Presence: publish OWN key + watch the roster. Own key only (no peer-key forge — residual 3); no
        // presence-stream purge/delete (no force-offline tamper). No presence kv.get (roster is the in-memory
        // watch cache + sweep), so no STREAM.MSG.GET on presence.
        `$KV.${presenceBucket(space)}.${principalKey(pr.owner, pr.actor).key}`,
        `$JS.API.STREAM.INFO.${PKV}`,
        `$JS.API.CONSUMER.CREATE.${PKV}.>`, // kv.watch ordered consumer (roster)
        `$JS.API.CONSUMER.INFO.${PKV}.>`,
        "$JS.FC.>", // ordered-consumer flow control
        // The ONE control service the supervisor CALLS (D5 slice 5): the delivery daemon's privileged
        // admin rail — the manager is the class-2 renewal owner, and after re-signing the daemon creds
        // files it requests `reloadCreds` here so adoption is an explicit, auditable event. Self-scoped
        // request subject (its own owner+actor slots), bounded reply subtree in sub.allow below.
        controlServiceSubject(space, CONTROL_DELIVERY_ADMIN, pr.owner, pr.actor),
      ],
    },
    sub: {
      // Own reply inbox + the delivery-admin reply subtree for its OWN requests. NO chat/inst/dlv
      // native sub (the supervisor reads no feed), NO manager control-tier serve (1d: that moved to
      // the endpoint-serve credential), NO broad `$JS.>`/`$KV.>` (the residual-2 read/admin path is gone).
      allow: [`_INBOX_${pr.connId}.>`, `${controlServiceSubject(space, CONTROL_DELIVERY_ADMIN, pr.owner, pr.actor)}.>`],
    },
  };
}

/** The human-CLI OPERATOR permission set (closure (ii), residual 2) — the ephemeral key the headless
 *  client commands mint (`cotal send dm|msg|ask`, `cotal dm`, `personas list --running`, via
 *  `openTransient`). It does exactly what those do: POST as itself (chat/DM/anycast — self-scoped, can
 *  never forge another actor), and READ the public roster (presence) + the channel registry to resolve a
 *  name→id and a channel's delivery class. Much narrower than the old broad `manager`: NO serve-control,
 *  NO DM/DLV body read, NO chat-history read, NO stream CREATE/DELETE/PURGE, NO ACL write, NO lease, NO
 *  provisioning. A leaked operator cred can post as itself and read the roster — the same surface as the
 *  human who ran the command. (The interactive `cotal join` console — chat read + own-DM receive — is a
 *  separate, fuller surface, deferred: it needs the unprovisioned-console DM self-create fixed first.) */
function operatorPermissions(space: string, pr: MintPrincipal): Record<string, unknown> {
  const PKV = `KV_${presenceBucket(space)}`, CHKV = `KV_${channelBucket(space)}`;
  return {
    pub: {
      allow: [
        // Post AS itself only — self-scoped (owner+actor), so a leaked operator cred can never forge a
        // message attributable to another principal.
        chatSubject(space, pr.owner, pr.actor, ">"), // chat.<o>.<a>.>  — multicast any channel as me
        unicastSubject(space, "*", "*", pr.owner, pr.actor), // inst.*.*.<o>.<a> — DM any peer as me
        anycastSubject(space, "*", pr.owner, pr.actor), // svc.*.<o>.<a>   — anycast any role as me
        `$KV.${presenceBucket(space)}.${principalKey(pr.owner, pr.actor).key}`, // own presence key only
        "$JS.API.INFO",
        // Presence watch (name→id resolution + the live roster) — read-only ordered consumer. No
        // STREAM.MSG.GET (the roster is the in-memory watch cache).
        `$JS.API.STREAM.INFO.${PKV}`,
        `$JS.API.CONSUMER.CREATE.${PKV}.>`,
        `$JS.API.CONSUMER.INFO.${PKV}.>`,
        // Channel registry read — the transient endpoint opens+watches it, and multicast reads a
        // channel's delivery class. Read-only (no `$KV.<channel>` write — that's the provisioner).
        `$JS.API.STREAM.INFO.${CHKV}`,
        `$JS.API.STREAM.MSG.GET.${CHKV}`,
        // Keyed KV get rides `DIRECT.GET.<stream>.$KV.<bucket>.<key>` — the key is in the SUBJECT, so
        // the grant needs the trailing `.>` (unlike STREAM.MSG.GET, which carries it in the payload).
        `$JS.API.DIRECT.GET.${CHKV}.>`,
        `$JS.API.CONSUMER.CREATE.${CHKV}.>`,
        `$JS.API.CONSUMER.INFO.${CHKV}.>`,
        "$JS.FC.>", // ordered-consumer flow control
      ],
    },
    // Own reply inbox only (presence/channel watch ordered-consumer delivery + any request replies land
    // here). NO chat/inst/dlv native sub — the operator posts and reads the roster, it receives no feed.
    sub: { allow: [`_INBOX_${pr.connId}.>`] },
  };
}

/** Connect-only PROBE (PR 1.5) — the liveness/auth preflight (`preflight.ts preflightTarget`, minted on
 *  ~every CLI command that resolves a mesh). `probeConnect` opens a connection to prove the broker is up
 *  and the creds are accepted, then closes it — it performs NO pub/sub. So the tightest possible grant:
 *  deny ALL publish, subscribe only to the own reply inbox. A leaked probe cred can open a socket and do
 *  nothing else. (Was the broad `manager` cred — minted on nearly every command, the worst over-grant.) */
function probePermissions(pr: MintPrincipal): Record<string, unknown> {
  return { pub: { deny: [">"] }, sub: { allow: [`_INBOX_${pr.connId}.>`] } };
}

/** CHANNEL-WRITER (PR 1.5) — edits the channel registry ONLY: `cotal channels set/default` and the
 *  `spawn -f` new-channel seed (`seedChannelRegistry`). It VALUE-writes `$KV.<channelBucket>` (a channel's
 *  config key) and read-before-writes it. NO stream data, NO other bucket, NO chat/DM — a leaked
 *  channel-writer can only rewrite channel config, never post, read a body, or tear a stream down. */
function channelWriterPermissions(space: string, pr: MintPrincipal): Record<string, unknown> {
  const CHKV = `KV_${channelBucket(space)}`;
  return {
    pub: {
      allow: [
        "$JS.API.INFO",
        `$KV.${channelBucket(space)}.>`, // create/update/delete a channel config key
        `$JS.API.STREAM.INFO.${CHKV}`, // kvm.open/create existence check
        `$JS.API.STREAM.CREATE.${CHKV}`, // kvm.create is create-if-matching (bucket already exists post-up)
        // read-before-write: kvm.open rides STREAM.MSG.GET; kvm.create (direct=true) rides keyed DIRECT.GET.
        `$JS.API.STREAM.MSG.GET.${CHKV}`,
        `$JS.API.DIRECT.GET.${CHKV}.>`,
      ],
    },
    sub: { allow: [`_INBOX_${pr.connId}.>`] },
  };
}

/** CHANNEL-PURGER (PR 1.5) — the `cotal web` dashboard's ONLY write path: delete a channel
 *  (`clearChannel` = filtered `STREAM.PURGE.CHAT` to drop the channel's messages + a `$KV.<channelBucket>`
 *  key delete). Pre-minted once by `web` so the account signing seed falls out of scope; the dashboard's
 *  READ side runs on the separate read-only `admin` cred. = channel-writer + the scoped CHAT purge. */
function channelPurgerPermissions(space: string, pr: MintPrincipal): Record<string, unknown> {
  const CHKV = `KV_${channelBucket(space)}`;
  // `clearChannel` only kvm.OPENs the (already-created) bucket, key-deletes, and purges — it never
  // kvm.creates, so — unlike channel-writer's set/default back-compat path — this cred gets NO
  // `STREAM.CREATE`. Compose the shared channel-KV read + delete verbs + the scoped CHAT purge explicitly.
  return {
    pub: {
      allow: [
        "$JS.API.INFO",
        `$KV.${channelBucket(space)}.>`, // delete the channel's registry key
        `$JS.API.STREAM.INFO.${CHKV}`, // kvm.open existence check
        `$JS.API.STREAM.MSG.GET.${CHKV}`, // read-before-delete
        `$JS.API.DIRECT.GET.${CHKV}.>`,
        `$JS.API.STREAM.PURGE.${chatStream(space)}`, // drop the channel's chat messages
      ],
    },
    sub: { allow: [`_INBOX_${pr.connId}.>`] },
  };
}

/** TEARDOWN (PR 1.5) — `cotal down -f` space teardown. The SOLE cred that keeps `STREAM.DELETE` (the
 *  face-b tamper verb). `down -f` is multi-step: `connectProbe` (presence-watch + channel-registry read)
 *  → invoke the manager's `ps` + any-mode `despawn` over the ep rails to politely stop the managed
 *  agents → `deleteChannels`
 *  (channel-registry key delete + CHAT purge) → `deleteSpace` (STREAM.DELETE all 13 space streams/buckets).
 *  So it reads state, CALLS admin control, deletes channels, and deletes streams — but NEVER reads a
 *  DM/DLV body, posts chat, or forges. Isolated here so no standing operator/provisioner/supervisor cred
 *  can delete a stream; a leaked teardown can wipe a space you own + stop its agents (that IS its job),
 *  nothing else. Minted ephemerally per teardown from the local trust material (same-checkout `down -f`). */
function teardownPermissions(space: string, pr: MintPrincipal): Record<string, unknown> {
  // The ep-rail mirror of the admin deploy tier (1c.2c): teardown reads `ps` and stops owned agents
  // it did not spawn (any-mode despawn) - the admin instrument set. Lifecycle-keyed, so a uid is
  // required at mint (fail-loud).
  const ep = instrumentEpRows(space, pr, "admin");
  const CHAT = chatStream(space);
  const PKV = `KV_${presenceBucket(space)}`, CHKV = `KV_${channelBucket(space)}`;
  // deleteSpace() deletes EVERY stream + KV bucket setup creates (5 streams + 7 KV buckets + the
  // artifact object store = 13); each needs INFO (jsm existence) + DELETE. This is the ONLY cred that
  // holds STREAM.DELETE (face-b isolated here). This list and deleteSpace()'s own array must agree:
  // a stream in one and not the other is either an undeletable leak or a grant for nothing.
  const del = [
    CHAT, dmStream(space), taskStream(space), inboxStream(space), dlvStream(space),
    PKV, CHKV, `KV_${membersBucket(space)}`, `KV_${aclBucket(space)}`,
    `KV_${membershipBucket(space)}`, `KV_${deliveryBucket(space)}`, `KV_${managerBucket(space)}`,
    objectStoreStream(artifactBucket(space)),
  ].flatMap((s) => [`$JS.API.STREAM.INFO.${s}`, `$JS.API.STREAM.DELETE.${s}`]);
  return {
    pub: {
      allow: [
        "$JS.API.INFO",
        // connectProbe read: presence watch (name→id + roster) + channel registry read.
        `$JS.API.CONSUMER.CREATE.${PKV}.>`,
        `$JS.API.CONSUMER.INFO.${PKV}.>`,
        `$JS.API.STREAM.MSG.GET.${CHKV}`,
        `$JS.API.DIRECT.GET.${CHKV}.>`,
        `$JS.API.CONSUMER.CREATE.${CHKV}.>`,
        `$JS.API.CONSUMER.INFO.${CHKV}.>`,
        "$JS.FC.>", // ordered-consumer flow control
        // Stop the managed agents over the v0.4 ep rails only (ps + any-mode despawn) — the admin
        // instrument set. The manager `ctl` rail is deleted (1d).
        ...ep.pub,
        ...del,
        // deleteChannels/clearChannel: purge the channel's chat messages + delete its registry key.
        `$JS.API.STREAM.PURGE.${CHAT}`,
        `$KV.${channelBucket(space)}.>`,
      ],
    },
    // Own inbox (connectProbe presence-watch delivery + JS API responses) + the ep reply rail (the
    // ps + any-mode despawn calls reply there). The `ctl.admin.<id>.reply.>` subtree is gone (1d).
    sub: { allow: [`_INBOX_${pr.connId}.>`, ...ep.sub] },
  };
}

/** CONTROL-CALLER (PR 1.5; ep-only since 1d) — the operator's lifecycle commands
 *  (`cotal ps/start/stop/attach`, `manager/commands.ts`). It invokes the manager's v0.4 service
 *  endpoint and reads the bounded reply on the ep reply rail. That is ALL — no `$JS`, no `$KV`,
 *  no chat/DM: it forges nothing, reads no body.
 *
 *  The tiers stay SPLIT because the BROKER grant is load-bearing (the 1c decision): an any-mode
 *  despawn/attach row *is* cross-agent reach — the manager maps mode `any` to its admin
 *  authorization path, so which ROWS an instrument holds is the tier boundary. Therefore:
 *   • `control-caller-privileged` (ps/start) holds the manager reads + untargeted `spawn` +
 *     `define-persona` — structurally barred from cross-agent ops (no any-mode row). This is the
 *     high-frequency path; it never needs admin reach.
 *   • `control-caller-admin` (stop/attach) adds the any-mode despawn/attach rows + the
 *     `manager.admin` family — it genuinely needs cross-agent reach. Its containment is the
 *     broker gating the any-mode rows + the cred being ephemeral (mint → one request →
 *     disconnect, from the local signing seed); on a user mesh the manager's serve-time ledger
 *     re-check sits on top. */
function controlCallerPermissions(space: string, pr: MintPrincipal, epTier: "privileged" | "admin", opts: MintOpts = {}): Record<string, unknown> {
  // 1d: the manager `ctl` rail is gone — an operator instrument holds ONLY its v0.4 ep rows (the
  // tier-matched request set, the reply rail, describe, the one epc fetch). The `epTier` selects
  // privileged (ps/start reads) vs admin (any-mode stop/attach) exactly as the ctl tier did.
  //
  // B6 / `--on <instanceId>`: these instruments are ONE-SHOT, minted per control call, and the
  // resolve that pins the instance happens BEFORE the mint. So the caller can hand the exact
  // instance id down and get the exact `ep.inst.<endpoint>.<iid>.<command>` row for THIS invocation
  // and nothing else — the least-privilege issuance, with no standing wildcard anywhere. The
  // `extra` seam is the same one the deployer's owner-equality `launch` row already rides, and the
  // emitter's `if (cap.instanceId)` branch validates the token, so a malformed id fails loud at
  // mint rather than widening a subject.
  const ep = instrumentEpRows(space, pr, epTier, opts.endpointCapabilities ?? []);
  return {
    // The PRIVILEGED tier (the `cotal ps` instrument) also carries the SCOPED §13.9 records read the
    // class scatter's freeze rides (P2 item 3): `freezeExpectedSet` enumerates `svc.<endpoint>.*.spec`
    // and LEADER-reads each frozen slot's svc spec/status before it scatters `ps` on the `all` rail.
    // The admin tier (stop/attach) never scatters, so it gets no records read.
    pub: { allow: epTier === "privileged" ? [...ep.pub, ...scatterFreezeReadRows(space)] : ep.pub },
    sub: { allow: [`_INBOX_${pr.connId}.>`, ...ep.sub] },
  };
}

/** The SCOPED §13.9 records-read rows the class-scatter freeze rides (P2 item 3, `cotal ps`): the
 *  `svc.*` enumeration consumer + the leader-served per-slot spec/status read of the endpoint's
 *  `svc` registry — a READ of exactly the service-registration keys, no write, no other bucket. A
 *  new D32 matrix row. The keyed Direct Get is subject-PINNED to `svc.>`; the enumeration consumer
 *  and the leader `STREAM.MSG.GET` are STREAM-scoped because the requested key rides the PAYLOAD
 *  (which a subject grant cannot narrow) — the SAME NAMED RESIDUAL every records reader already
 *  accepts (the provisioner, the lifecycle/serve executors): for this EPHEMERAL one-shot instrument's
 *  lifetime it can READ (never write) any records-store row — registration metadata, no secrets. */
function scatterFreezeReadRows(space: string): string[] {
  const REC = recordsBucket(space);
  return [
    // The `svc.<e>.*.spec` enumeration is a `STREAM.INFO` carrying a `subjects_filter` — ONE
    // read-only metadata verb. It replaced a `kv.keys()` that rode an ordered ephemeral consumer and
    // therefore needed CONSUMER.CREATE/INFO/DELETE on this bucket: three consumer-lifecycle verbs to
    // list keys, on a credential that only ever wanted to read them.
    //
    // MEASURED, not assumed: with the enumeration converted and this row absent, the static/operator
    // `cotal ps` is refused on `$JS.API.STREAM.INFO.KV_<records>` — a path that works today. The
    // conversion and this row land TOGETHER or the operator path regresses.
    `$JS.API.STREAM.INFO.KV_${REC}`,
    // The per-slot spec/status reads (`freezeExpectedSet` + the registration reconcile) are
    // leader-served `STREAM.MSG.GET` — stream-scoped (NAMED RESIDUAL above), plus the subject-pinned
    // keyed Direct Get form for any direct-aware read path (scoped to the `svc.` registry prefix).
    `$JS.API.STREAM.MSG.GET.KV_${REC}`,
    `$JS.API.DIRECT.GET.KV_${REC}.$KV.${REC}.svc.>`,
  ];
}

/** The v0.4 ep-rail rows of an operator INSTRUMENT credential (the 1c grant-migration table's
 *  admin row): the tier-matched {@link operatorInstrumentCapabilities} request rows + the caller's
 *  reply rail, the wildcard `describe` form, and the ONE subject-scoped §13.7 contract-store fetch
 *  row (the same shape the agent baseline holds; the D32 audit's single exemption). These mirror
 *  the instrument's ctl tier onto the ep rails during dual-serve; at 1d the ctl row disappears and
 *  these ARE the instrument. The caller triple pins the instrument's own mint-time lifecycle uid
 *  ({@link MintPrincipal.lifecycleUid}) — REQUIRED here: without it the reply rail cannot be pinned
 *  and the mint fails loud rather than emit a triple-less (unfenced) caller surface. `extra` lets a
 *  profile append its tier-refined additions (the user-mode deployer's owner-equality `launch`). */
function instrumentEpRows(
  space: string,
  pr: MintPrincipal,
  tier: "privileged" | "admin",
  extra: EpCapability[] = [],
): { pub: string[]; sub: string[] } {
  if (!pr.lifecycleUid)
    throw new Error(`permissionsFor: an operator instrument's ep caller rows are lifecycle-keyed (SPEC 13.1/13.2) - mint with opts.lifecycleUid (mintLifecycleUid()) so the reply rail pins the instrument's own incarnation`);
  const epCaller = { owner: pr.owner, actor: pr.actor, uid: pr.lifecycleUid };
  const rows = epCallerGrantRows(space, [...operatorInstrumentCapabilities(tier, pr.owner), ...extra], epCaller);
  return {
    pub: [
      epDescribeAllGrantRow(space, epCaller),
      `$JS.API.DIRECT.GET.${epcStreamName(space)}.${spacePrefix(space)}.epc.>`,
      ...rows.pub,
    ],
    sub: rows.sub,
  };
}

/** ENDPOINT-SERVE (v0.4, SPEC §13.9 "Serve grants") — the per-instance serve credential:
 *  EXACTLY the instance's registered rails and nothing else. Subscribe: the queue-qualified
 *  class rail, the plain scatter rail, and the own-instance rail for the FULL registered
 *  command set plus the derived `describe`, and the own epoch-pinned timer-fire subjects;
 *  publish: the epoch-pinned egress (reply / `epe` events / `ept` schedule requests / `epr`
 *  record-write ingress) plus, from the branded snapshot only, the §13.9 bind rows: the shared
 *  `eff_<e>` effects bind iff the surface is journal-class and each owned `pool_<e>_<pool>`
 *  bind (bind-only + `$JS.API.INFO`; an ephemeral-only poolless endpoint emits none). No agent
 *  baseline of any kind — no chat/DM/anycast/presence/ctl, no broad `$JS.>`. The value MUST be the
 *  branded ARTIFACT `authorizeServeGrant` returned, and its mint context binds: same space, and
 *  the minted principal is the registered owner. This builds the ROWS; the RELEASE fence is the
 *  durable issuance-gate CAS `mintCreds` runs (SPEC §13.1) — a raw/copied/diverging value or a
 *  foreign space/principal refuses here, and a stale incarnation loses the gate CAS. */
function endpointServePermissions(space: string, pr: MintPrincipal, opts: MintOpts): Record<string, unknown> {
  if (!opts.endpointServe)
    throw new Error("permissionsFor: endpoint-serve requires opts.endpointServe (the authorized serve artifact)");
  // The fence is INSEPARABLE from serve-row emission: a serve credential's rows are only ever
  // valid when released behind the §13.1 issuance CAS, so this builder refuses to emit them
  // without the gate seam — closing the exported-permissionsFor bypass where a direct signer
  // could obtain unfenced serve rows past the brand/space/owner check. `mintCreds` runs the CAS.
  if (!opts.serveIssuance)
    throw new Error("permissionsFor: endpoint-serve requires opts.serveIssuance (serve rows are emitted only behind the §13.1 issuance fence; mintCreds runs its CAS before release)");
  const snap = assertServeGrantMintable(opts.endpointServe, { space, holderOwner: pr.owner });
  // Rail subscribe rows cover the EPHEMERAL commands only (journal commands ride epj, never the
  // request rails) + the derived describe; the descriptor surface stays full. The class comes
  // from the brand-verified artifact surface, not the caller.
  const ephemeralCommands = snap.commands.filter((cmd) => opts.endpointServe!.surface[cmd].class === "ephemeral");
  const rows = epServeGrantRows(space, {
    endpoint: snap.endpoint, instanceId: snap.instanceId, epoch: snap.epoch, ephemeralCommands,
  });
  // §13.9:2473 bind rows, from the BRANDED snapshot only (journal class is registered truth,
  // pools are the authorizing provisioner's pre-created durables): a journal-class instance
  // binds the shared `eff_<e>` effects durable, a pool-owning one binds each owned
  // `pool_<e>_<pool>` — all bind-only (INFO/MSG.NEXT/ACK, never create/delete), plus the one
  // `$JS.API.INFO` a pull consumer needs. An ephemeral-only poolless endpoint emits NONE of
  // these rows (default-deny both directions).
  const bindRows: string[] = [];
  if (snap.journalClass) bindRows.push(...effectsBindGrants(space, snap.endpoint));
  for (const pool of snap.pools) bindRows.push(...poolOwnerBindGrants(space, snap.endpoint, pool));
  if (bindRows.length > 0) bindRows.push("$JS.API.INFO");
  return {
    pub: { allow: [...rows.pub, ...bindRows] },
    sub: { allow: [...rows.sub, `_INBOX_${pr.connId}.>`] },
  };
}

/** DEPLOYER (PR 1.5) — the `cotal spawn -f` manifest-deploy authority. `spawn -f` drives ONE
 *  `connectProbe` endpoint that both READS live state (roster/presence watch, channel registry,
 *  membership feed, manager-singleton lease) AND invokes the running manager's `launch` + `ps`
 *  readiness over the v0.4 ep rails. Those interleave on one connection, so a strict 3-connection
 *  split would only refactor `live.ts` for marginal gain; `deployer` is that one coherent,
 *  ephemeral deploy cred. It is the SOLE profile that combines reads + admin-control — NOT a template a
 *  4th command should reach for (revisit the connection split before adding a second such caller).
 *
 *  Boundaries (all enforced by omission / default-deny): NO self-post (`chat`/`inst`/`svc`), NO `$JS.>`,
 *  NO `STREAM.DELETE`/`PURGE`/`UPDATE`, NO DM/DLV/TASK `CONSUMER.CREATE` (no body-read surface), NO `$KV`
 *  writes (channel seeding rides a SEPARATE `channel-writer` cred). It holds the admin INSTRUMENT ep
 *  set (any-mode despawn/attach + the manager.admin family + reads) because manifest launch/ps
 *  genuinely need cross-agent reach — and that IS real power: the manager's any-mode authz is
 *  subject-gated (the any-mode ep row is mintable only under operator policy), so holding it lets it
 *  stop/attach/launch ANY agent. The BROKER gating that row is the boundary. Containment is therefore
 *  the LIFETIME, not a manager re-check: minted from LOCAL same-checkout auth for one `spawn -f`,
 *  memory-only, dropped after deploy. If it is ever persisted, handed to user-supplied `--creds`, or
 *  reused as a general "read + admin" cred, revisit. */
function deployerPermissions(space: string, pr: MintPrincipal, epTier: "privileged" | "admin" = "admin", opts: MintOpts = {}): Record<string, unknown> {
  // The v0.4 ep rows of the deploy authority: static (admin) deploys carry the admin instrument
  // set; the user-mode deployer VIEW (privileged) carries the privileged set PLUS an untargeted
  // `launch` row — its launch stays owner-equality-authorized (the manager's ledger-derived admin
  // flag is false for a spawn-scoped deployer), exactly the v0.3 user-mode privileged-tier launch.
  // B6 / `--on`: the per-invocation pin APPENDS to this profile's standing set, never replaces it -
  // the privileged deployer view keeps its owner-equality `launch` row and additionally gets the one
  // exact `ep.inst.<endpoint>.<iid>.<command>` row for the instance this deploy resolved.
  const pinned = opts.endpointCapabilities ?? [];
  const ep = epTier === "admin"
    ? instrumentEpRows(space, pr, "admin", pinned)
    : instrumentEpRows(space, pr, "privileged", [{ endpoint: BASELINE_LIFECYCLE_ENDPOINT, command: "launch" }, ...pinned]);
  const PKV = `KV_${presenceBucket(space)}`, CHKV = `KV_${channelBucket(space)}`;
  const MSHIP = `KV_${membershipBucket(space)}`, MGRKV = `KV_${managerBucket(space)}`;
  const DLVKV = `KV_${deliveryBucket(space)}`;
  // Read verbs for a KV bucket SCANNED/WATCHED via an ordered consumer (presence, channel registry, and
  // the membership feed — `readMembership` enumerates keys via `kv.keys()`): existence + kv.get (both
  // STREAM.MSG.GET and keyed DIRECT.GET forms) + the ordered consumer. NO `$KV.<bucket>` publish → no write.
  const kvScan = (bucket: string) => [
    `$JS.API.STREAM.INFO.${bucket}`,
    `$JS.API.STREAM.MSG.GET.${bucket}`,
    `$JS.API.DIRECT.GET.${bucket}.>`,
    `$JS.API.CONSUMER.CREATE.${bucket}.>`,
    `$JS.API.CONSUMER.INFO.${bucket}.>`,
  ];
  // A KV bucket read by a KEYED point-get only (`readManagerLease` = kvm.open + `kv.get(LEASE_KEY)`, no
  // scan/watch): existence + kv.get, but NO ordered-consumer verbs (nothing enumerates or watches it).
  const kvPointRead = (bucket: string) => [
    `$JS.API.STREAM.INFO.${bucket}`,
    `$JS.API.STREAM.MSG.GET.${bucket}`,
    `$JS.API.DIRECT.GET.${bucket}.>`,
  ];
  return {
    pub: {
      allow: [
        "$JS.API.INFO",
        ...kvScan(PKV), // presence watch — roster + name→id
        ...kvScan(CHKV), // channel registry read (readChannelRegistry + classifyChannels)
        ...kvScan(MSHIP), // membership FEED read (readMembership → detectUnmanagedActors) — the membership_ bucket
        ...kvPointRead(MGRKV), // manager-singleton lease keyed read (waitManagerReady) — point-get, NO write, NO watch
        ...kvPointRead(DLVKV), // delivery-lease keyed read (preserve-state quiescence proof) — point-get, NO write, NO watch
        "$JS.FC.>", // ordered-consumer flow control
        // 1d: launch + ps readiness ride the v0.4 ep rows only (the manager `ctl` rail is gone).
        // Static deploys carry the admin instrument set; the user-mode deployer VIEW carries the
        // privileged set + an owner-equality `launch` row (the manager's ledger-derived admin flag
        // is false for a spawn-scoped deployer, so its launch stays owner-equality-authorized).
        ...ep.pub,
      ],
    },
    // Own inbox (presence/registry watch delivery + JS API responses) + the ep reply rail.
    sub: { allow: [`_INBOX_${pr.connId}.>`, ...ep.sub] },
  };
}

/** The ephemeral PURGER permission set (closure (ii), residual 2) — minted per-purge inside the daemon's
 *  `opPurge` and `cotal history clear`. Isolates the DESTRUCTIVE history-purge grant
 *  (`STREAM.PURGE.CHAT` + `STREAM.PURGE.DM`) off the always-on supervisor: `--dms` purges the DM stream,
 *  exactly the grant the supervisor must not hold. It PURGES but never READS — no DM/chat consumer, no
 *  `MSG.GET` — so a leaked purger can drop history but cannot read a body. Short-lived (one purge call). */
function purgerPermissions(space: string, pr: MintPrincipal): Record<string, unknown> {
  const CHAT = chatStream(space), DM = dmStream(space);
  return {
    pub: {
      allow: [
        "$JS.API.INFO", // jetstreamManager bootstrap; STREAM.PURGE needs no prior STREAM.INFO
        `$JS.API.STREAM.PURGE.${CHAT}`, // clearSpaceHistory chat purge
        `$JS.API.STREAM.PURGE.${DM}`, // clearSpaceHistory includeDms — the isolated DM-purge grant
      ],
      // NOTE: this profile does NOT cover `clearChannel` (web/`down -f` channel-delete) — that also does a
      // `$KV.<channelBucket>.<ch>` registry delete this cred lacks; it stays on the broad operator/CLI cred.
    },
    sub: { allow: [`_INBOX_${pr.connId}.>`] },
  };
}

/** The ephemeral PROVISIONER permission set (closure (ii), residual 2) — the onboarding authority,
 *  carved off the long-lived manager. Minted short-lived for per-spawn provisioning (pre-create each
 *  agent's bind-only DM/DLV/TASK durables + record its read ACL via `commitAcl`) — the daemon opens it per
 *  spawn (`manager.ts withProvisioner`). It is ALSO the cred that creates the space's streams + KV buckets
 *  and seeds the channel registry via `setupSpaceStreams` (exercised by the manager-split smoke) — and
 *  `cotal up`'s ephemeral setup cred (`up.ts authSetup`) now mints THIS profile, not the broad `manager`.
 *  NEVER minted for an agent — `cotal mint` whitelists
 *  agent/observer/admin only, like `manager`/`delivery`.
 *
 *  This profile HOLDS the DM/DLV `CONSUMER.CREATE` push-consumer surface — the irreducible onboarding
 *  power (the create-time `deliver_subject` of a push consumer is not ACL-constrained, so whoever can
 *  create a DM/DLV consumer can stream the bodies). That is exactly why it is split OFF the always-on
 *  supervisor and made EPHEMERAL: the daemon opens a provisioner connection per spawn and drains it
 *  immediately, so the surface exists only for the provisioning window, not as a standing target. The
 *  cred is MEMORY-ONLY (never written to `.cotal`) and now carries a short profile-default `exp`; signer
 *  rotation, live eviction, and full revocation are later D5 slices.
 *
 *  `$JS` is an ENUMERATED allow-list, never `$JS.>`: STREAM.CREATE + INFO for the space streams/buckets,
 *  DM/DLV/TASK consumer CREATE/DURABLE.CREATE/INFO — and deliberately NO `MSG.NEXT`/`MSG.GET`/`ACK` on
 *  DM/DLV (it creates the bind-only mailbox but never reads it), and NO STREAM.DELETE/PURGE/MSG.DELETE
 *  (it provisions, it does not tear down). STREAM.UPDATE is held on EXACTLY four streams and no others:
 *  the three TTL'd KV buckets (presence + the two leases, #286 — an existing bucket's `max_age` cannot be
 *  fixed by `kvm.create`, so reconciling a pre-TTL deployment requires updating it) and the records store.
 *  Stated positively on purpose: this docblock previously read "NO …/UPDATE", which was already untrue of
 *  the records stream and became untrue of the buckets, and a comment that denies a credential's real
 *  power is worse than none — it is the document a reader trusts instead of checking. KV value-writes are
 *  scoped to exactly the two
 *  registries provisioning touches: the read-ACL bucket (`commitAcl`) and the channel registry (seed). */
function provisionerPermissions(space: string, pr: MintPrincipal): Record<string, unknown> {
  const CHAT = chatStream(space), DM = dmStream(space), TASK = taskStream(space);
  const INBOX = inboxStream(space), DLV = dlvStream(space);
  // Every backing stream the provisioner pre-creates — the 5 message streams + the KV buckets (a bucket's
  // backing stream is `KV_<bucket>`). `managerBucket` is now pre-created here too (so the supervisor binds
  // its lease open-only); members/membership/delivery are written by other creds but created at setup here.
  // The §13.12 AUTHORITY stores (records + auth + the P2 item 6 session ledger) join the list for the
  // STATIC manager's start-time `createEndpointStreams` (a superset of ensureAuthorityStores +
  // createSessionsStore): create-or-verify only — the provisioner holds NO value-write on any of them
  // (lifecycle state moves through the key-pinned `lifecycle-executor` cred; session rows through the
  // scoped `session-ledger` cred).
  const buckets = [
    presenceBucket, channelBucket, membersBucket, aclBucket, membershipBucket, deliveryBucket, managerBucket,
    recordsBucket, epAuthBucket, sessionsBucket,
  ].map((b) => `KV_${b(space)}`);
  // STREAM.CREATE + INFO for each (idempotent setup at `cotal up`; CREATE is create-if-matching, INFO covers
  // the client's existence checks). NO DELETE/PURGE — provisioning never tears a stream down.
  // The §13.7 CONTRACT store (EPC) joins the list for the static manager's start-time
  // `ensureContractStore` (P2 item 1, 1c): create-or-verify only — the provisioner holds no
  // artifact-publish grant on it (publication rides the scoped endpoint-serve executor).
  // The seven §13.12 ENDPOINT streams join the list (P2 item 2): spawn-as-action makes the manager
  // the first EPF (goal facts) + EPE (progress) writer, and nothing provisioned the endpoint streams
  // before (no manager code wrote to them), so `createEndpointStreams` now runs at the manager's
  // start-time ensure over this provisioner. Create-or-verify only (idempotent, fail-loud on drift);
  // the provisioner holds no value-write on any of them (goal facts ride the scoped goal-writer cred).
  // WFJ joins them without joining "the seven": it is the workflow step journal, a RUNTIME layer
  // over the control surface rather than one of the §13.12 endpoint streams, and it is listed here
  // for exactly one reason — `createEndpointStreams` creates it, so a provisioner without its
  // CREATE/INFO rows fails the ensure. Create-or-verify only; the provisioner appends nothing (a
  // run's entries ride the per-run driver grant, which is minted per run and never space-wide).
  const endpointStreams = [epjStreamName, epfStreamName, epeStreamName, eptReqStreamName, eprStreamName, eptStreamName, epwStreamName, wfjStreamName].map((f) => f(space));
  // The artifact Object Store joins the list: `setupSpaceStreams` creates it, and under auth mode the
  // provisioner is the cred doing that creating. Its backing stream is `OBJ_<bucket>` - named
  // explicitly, because `$O.<bucket>.>` is outside the `cotal.<space>.>` grammar and no space-prefix
  // grant reaches it. CREATE + INFO only: the provisioner never publishes an object, never creates a
  // consumer on it, and never deletes it. That confinement is load-bearing rather than tidy - the
  // object-store client reads by creating an ephemeral PUSH consumer with a caller-chosen
  // `deliver_subject`, so a CONSUMER.CREATE here would be an exporter of every artifact in the space.
  const OBJ = objectStoreStream(artifactBucket(space));
  const streamSetup = [CHAT, DM, TASK, INBOX, DLV, epcStreamName(space), OBJ, ...endpointStreams, ...buckets].flatMap((s) => [
    `$JS.API.STREAM.CREATE.${s}`,
    `$JS.API.STREAM.INFO.${s}`,
  ]);
  // #286: STREAM.UPDATE on EXACTLY the three TTL'd KV streams (presence + the two leases). `kvm.create`
  // never updates an existing bucket's config, so a bucket created by a cotal that predates the `max_age`
  // TTL keeps NO expiry forever — dead presence records (and stale leases) never age out. `setupSpaceStreams`
  // reconciles their `max_age` via STREAM.UPDATE at every `cotal up`, which needs this grant. Scoped to these
  // three streams only — the durable streams (chat/dm/task/inbox/dlv, channel/members/acl/membership
  // registries) are never updated — and still NO DELETE/PURGE. The supervisor profile keeps its full UPDATE
  // denial; this widening is provisioning-only.
  // Derived from the SAME inventory that creates and reconciles them, not a third hand-kept copy.
  // Review found this list was the last independent one: a fourth TTL'd bucket added to `ttlBuckets`
  // would be created and reconciled correctly and then die on a permissions violation here, because
  // the grant never learned about it. Same defect one seam out — a bucket the code knows to maintain
  // and the credential is not allowed to.
  const ttlStreams = ttlBuckets(space).map(([bucket]) => `KV_${bucket}`);
  const streamReconcile = ttlStreams.map((s) => `$JS.API.STREAM.UPDATE.${s}`);
  // DM/DLV/TASK durable pre-create (bind-only mailboxes): both the new-API CREATE and legacy DURABLE.CREATE
  // forms (the client's consumer-add path varies by version), plus INFO (the add returns ConsumerInfo).
  // NO MSG.NEXT/MSG.GET/ACK — the provisioner creates the consumer but MUST NOT read its body.
  const consumerCreate = [DM, DLV, TASK].flatMap((s) => [
    `$JS.API.CONSUMER.CREATE.${s}.>`,
    `$JS.API.CONSUMER.DURABLE.CREATE.${s}.>`,
    `$JS.API.CONSUMER.INFO.${s}.>`,
  ]);
  return {
    pub: {
      allow: [
        "$JS.API.INFO",
        ...streamSetup,
        ...streamReconcile,
        ...consumerCreate,
        // KV value-writes — exactly the two registries provisioning writes: the agent read-ACL registry
        // (`commitAcl` at provision) and the channel registry (seed defaults at `cotal up`, channel admin).
        // NO presence/members/membership/delivery writes (the agent's own key, the delivery cred, and the
        // membership-rw cred own those).
        `$KV.${aclBucket(space)}.>`,
        `$KV.${channelBucket(space)}.>`,
        // ...and READ both: commitAcl read-before-writes the ACL (`kvm.open`, direct=false ⇒ STREAM.MSG.GET);
        // the channel seed read-before-writes defaults (`kvm.create`, direct=true ⇒ DIRECT.GET). Grant both
        // read verbs on both buckets to cover the open/create-path variance — reads of registries it already
        // writes, no escalation. Without these the read-before-write rejects and provisioning/seed throws.
        `$JS.API.STREAM.MSG.GET.KV_${aclBucket(space)}`,
        `$JS.API.DIRECT.GET.KV_${aclBucket(space)}.>`, // keyed get: `.>` (the key rides the subject)
        `$JS.API.STREAM.MSG.GET.KV_${channelBucket(space)}`,
        `$JS.API.DIRECT.GET.KV_${channelBucket(space)}.>`, // keyed get: `.>` (the key rides the subject)
        // The Unit B static-manager start path: `ensureAuthorityStores` UPDATEs the records store's
        // deny-flags exactly once at fresh creation (create → update → verify), and the boot
        // reconciliation sweep enumerates the manager's slot rows (`keys()` → an ordered consumer)
        // then reads each slot BODY (phase/uid/actor) to plan resume — the reads ride the
        // stream-scoped MSG.GET residual named below (records lifecycle metadata, no secrets).
        `$JS.API.STREAM.UPDATE.KV_${recordsBucket(space)}`,
        `$JS.API.CONSUMER.CREATE.KV_${recordsBucket(space)}.>`,
        `$JS.API.CONSUMER.INFO.KV_${recordsBucket(space)}.>`,
        `$JS.API.CONSUMER.DELETE.KV_${recordsBucket(space)}.>`,
        // ...and reads the slot-mapping rows so the sweep can plan resume actions. The KV client
        // reads a lazily-bound bucket via leader-served `STREAM.MSG.GET` — stream-scoped, NOT
        // key-scoped (the requested key rides the PAYLOAD). NAMED RESIDUAL: for its one-shot
        // lifetime the provisioner can READ (never write) any records-store row — lifecycle
        // metadata, no secrets. The keyed Direct Get grant stays for direct-aware read paths.
        `$JS.API.STREAM.MSG.GET.KV_${recordsBucket(space)}`,
        `$JS.API.DIRECT.GET.KV_${recordsBucket(space)}.$KV.${recordsBucket(space)}.${STATIC_SLOT_PREFIX}.>`,
      ],
    },
    // Replies only: every stream/consumer/KV-create PubAck and JS API response lands on the per-id inbox.
    // NO chat/inst/dlv/ctl subscription — the provisioner never serves control nor reads any feed.
    sub: { allow: [`_INBOX_${pr.connId}.>`] },
  };
}

/** The ephemeral, LIFECYCLE-PINNED §13.1 state-write permission set for the STATIC manager's
 *  lifecycle executor (Unit B). One credential per lifecycle OPERATION (activation, terminal,
 *  renewal ledger append): every grant names exactly ONE incarnation's keys — the alias head,
 *  the uid reservation, the manager slot row, the issuance gate, and the `cred.<uid>.>` ledger
 *  family — so a leaked executor cred can move one incarnation's state machine and nothing else.
 *
 *  Reads: records reads ride the keyed Direct Get form (the key is ON the subject, so the read
 *  grant stays key-pinned); the auth store is leader-served (`allow_direct=false`), so its reads
 *  are body-selected `STREAM.MSG.GET` — stream-scoped, NOT key-scoped (the requested key rides
 *  the PAYLOAD, which a subject grant cannot see). NAMED RESIDUAL: for its one-shot lifetime the
 *  executor can READ (never write) other rows in the auth store. */
function lifecycleExecutorPermissions(
  space: string,
  pr: MintPrincipal,
  pin: { owner: string; actor: string; lifecycleUid: string; alias: string },
): Record<string, unknown> {
  const REC = recordsBucket(space), AUTH = epAuthBucket(space);
  // ALL keys DERIVED here from the pin coordinates — the slot key is `staticSlotKey(owner, alias)`,
  // NOT a caller-supplied literal, so a mis-constructed pin can only ever name ONE coherent
  // incarnation's rows (guard the core: the profile enforces the "one incarnation" promise, it
  // does not merely assert it). The builders throw on any non-KV-safe segment.
  const recordKeys = [lifecycleHeadKey(pin.owner, pin.actor), uidReservationKey(pin.lifecycleUid), staticSlotKey(pin.owner, pin.alias)];
  return {
    pub: {
      allow: [
        "$JS.API.INFO",
        // Records-store CAS writes — the value-publish carries the key on the subject, so each
        // grant names exactly one of this incarnation's keys.
        ...recordKeys.map((k) => `$KV.${REC}.${k}`),
        // Auth-store CAS writes — this incarnation's gate + its cred-ledger family (renewals
        // append rows here; the terminal's B1 revoke CASes them).
        `$KV.${AUTH}.${issuanceGateKey(pin.lifecycleUid)}`,
        `$KV.${AUTH}.cred.${pin.lifecycleUid}.>`,
        // Keyed Direct Get reads of the same records keys (key-pinned) for direct-aware read
        // paths, PLUS the leader-served `STREAM.MSG.GET` the lazily-bound KV client actually
        // uses — stream-scoped, NOT key-scoped (the requested key rides the PAYLOAD, which a
        // subject grant cannot see). NAMED RESIDUAL: for its one-shot lifetime the executor can
        // READ (never write) other rows in BOTH authority stores — lifecycle metadata, no
        // secrets; every WRITE stays key-pinned above.
        ...recordKeys.map((k) => `$JS.API.DIRECT.GET.KV_${REC}.$KV.${REC}.${k}`),
        `$JS.API.STREAM.MSG.GET.KV_${REC}`,
        `$JS.API.STREAM.MSG.GET.KV_${AUTH}`,
      ],
    },
    sub: { allow: [`_INBOX_${pr.connId}.>`] },
  };
}

/** The ephemeral, ENDPOINT-INSTANCE-PINNED endpoint-serve executor permission set (P2 item 1,
 *  1a-serve): the manager mints this per registration/serve-mint op and drives the endpoint
 *  registration barrier's `epgate` CAS + the mint fence's `epcred` stage/revoke THROUGH it — never
 *  its standing seed/supervisor connection (critic #1's manager-specific "no seed shortcut"). Every
 *  WRITE is key-pinned to exactly ONE (endpoint, instanceId): the gate `epgate.<ep>.<iid>`, its
 *  serving ledger family `epcred.<ep>.<iid>.>`, and the registration's two records keys (the
 *  instance's `svc` spec + the endpoint's governance head — `registerServiceInstance` drives the
 *  slot-take/promote over this same connection). A leaked/mis-constructed executor can move exactly
 *  one endpoint instance's serve state and nothing else. The auth store is `allow_direct=false`, so
 *  reads are leader-served `STREAM.MSG.GET` (stream-scoped, NOT key-scoped — the key rides the
 *  payload); enumeration of the epcred family rides an ordered `keys()` consumer. NAMED RESIDUAL:
 *  for its one-shot lifetime the executor can READ (never write) other auth rows — endpoint/
 *  credential metadata, no bearer bytes; every WRITE stays key-pinned. */
/** The SELF-MEDIATED goal-writer profile (P2 item 2, spawn-as-action): exactly
 *  {@link goalWriterGrants} for ITS endpoint — the goal bind + terminal facts, the goal-record KV
 *  writes, and the leader-served fencing reads — plus the connection-scoped reply inbox. Disjoint
 *  from the endpoint's serve credential (Q2): a serve connection carries none of these rows, so it
 *  is broker-denied every goal write. */
function goalWriterPermissions(space: string, pr: MintPrincipal, pin: { endpoint: string }): Record<string, unknown> {
  const g = goalWriterGrants(space, pin.endpoint, pr.connId);
  return { pub: { allow: g.publish }, sub: { allow: g.subscribe } };
}

/** The console/CLI per-session CALLER rows (P2 item 6): RAILS-ONLY for ONE §13.6 session — pub the
 *  session's epoch-pinned `in` rail, sub its `out` rail plus the caller's own reply inbox, and
 *  NOTHING else. Deliberately NO KV, NO JetStream API, NO store: the caller drives the terminal over
 *  the two core-only eps subjects and never reads the session ledger, so there is no subject-blind
 *  store read to widen (SPEC §13.9). The endpoint+sessionId+epoch pin the EXACT pair, so a cred for
 *  session A authorizes nothing of session B (no wildcard). `epsSubject` validates every token, so a
 *  malformed coordinate refuses at the mint rather than emitting a broadened subject. */
function sessionCallerPermissions(space: string, pr: MintPrincipal, pin: { endpoint: string; sessionId: string; epoch: number } | undefined): Record<string, unknown> {
  if (!pin) throw new Error('permissionsFor: "session-caller" requires opts.sessionCaller ({endpoint, sessionId, epoch}) - the ONE session\'s rails this cred may use');
  return {
    pub: { allow: [epsSubject(space, pin.endpoint, pin.sessionId, pin.epoch, "in")] },
    sub: { allow: [epsSubject(space, pin.endpoint, pin.sessionId, pin.epoch, "out"), `_INBOX_${pr.connId}.>`] },
  };
}

/** The manager's per-session SERVING rows (P2 item 6): the EXACT mirror of
 *  {@link sessionCallerPermissions} with the directions swapped — sub the ONE session's epoch-pinned
 *  `in` rail (caller→serving), pub its `out` rail (serving→caller), plus the connection-scoped reply
 *  inbox, and NOTHING else. Same asymmetry §13.6 states: "the caller publishes `in` and subscribes
 *  `out`; the serving instance the reverse".
 *
 *  Deliberately NO KV and NO JetStream API — not even the session ledger. The serving side drives
 *  bytes; the ledger is the standing `session-ledger` credential's, on a different connection. That
 *  separation is what lets this credential be one-shot and die with its session while the durable
 *  revocation authority outlives it (§13.6).
 *
 *  This REPLACES a standing writer that held `eps.<endpoint>.*.<epoch>.{in,out}` and so could read
 *  and write every live session's bytes at its epoch. The pin makes a credential for session A
 *  authorize nothing of session B, and `epsSubject` validates every token, so a malformed
 *  coordinate refuses at the mint rather than emitting a broadened subject. */
function sessionServingPermissions(space: string, pr: MintPrincipal, pin: { endpoint: string; sessionId: string; epoch: number } | undefined): Record<string, unknown> {
  if (!pin) throw new Error('permissionsFor: "session-serving" requires opts.sessionServing ({endpoint, sessionId, epoch}) - the ONE session\'s rails this cred may serve');
  return {
    pub: { allow: [epsSubject(space, pin.endpoint, pin.sessionId, pin.epoch, "out")] },
    sub: { allow: [epsSubject(space, pin.endpoint, pin.sessionId, pin.epoch, "in"), `_INBOX_${pr.connId}.>`] },
  };
}

/** The manager's SESSION-LEDGER rows (P2 item 6): the DEDICATED sessions-bucket rows and nothing
 *  else — no session rail of any shape. Needs no pin: the grant carries no endpoint, epoch, or
 *  session component, because §13.6's durable revocation authority is per-space, not per-session
 *  (it must still be able to resolve and revoke a row after the endpoint that served it is gone).
 *  {@link sessionLedgerGrants} carries the row rationale, the §13.9 subject-blindness confinement,
 *  and the named `session.*` breadth residual. */
function sessionLedgerPermissions(space: string, pr: MintPrincipal): Record<string, unknown> {
  const g = sessionLedgerGrants(space, pr.connId);
  return { pub: { allow: g.publish }, sub: { allow: g.subscribe } };
}

function endpointServeExecutorPermissions(
  space: string,
  pr: MintPrincipal,
  pin: { endpoint: string; instanceId: string },
): Record<string, unknown> {
  const AUTH = epAuthBucket(space), REC = recordsBucket(space);
  // DERIVED from (endpoint, instanceId) via the core builders — never a caller literal.
  const gateKey = epgateKey(pin.endpoint, pin.instanceId);
  const credPrefix = epcredFamilyPrefix(pin.endpoint, pin.instanceId);
  // The registration writes this ONE instance's spec key plus the endpoint's governance head
  // (`registerServiceInstance` PHASE 1/3b: the slot-take + promote ride the SAME executor), and this
  // instance's own svc STATUS key (P2 item 3: the manager writes its CONVERGED `ready` status so it
  // is a §13.5 scatter member — `freezeExpectedSet` requires a status caught up to the current
  // registration; the write is epoch-fenced by `writeServiceStatus`).
  const recordKeys = [
    recordSpecKey(RECORD_KINDS.svc, [pin.endpoint, assertLifecycleToken(pin.instanceId, "instanceId")]),
    recordStatusKey(RECORD_KINDS.svc, [pin.endpoint, assertLifecycleToken(pin.instanceId, "instanceId")]),
    recordAtomicKey(GOVERN_HEAD, [pin.endpoint]),
  ];
  return {
    pub: {
      allow: [
        "$JS.API.INFO",
        // The key-pinned WRITE grants: the gate (provision create + barrier freeze/reopen CAS),
        // the serving ledger family (mint-fence stage + barrier revoke), and the registration's
        // two records-store keys (spec CAS + governance slot/promote). The value-publish carries
        // the key on the subject, so each grant names exactly this instance's keys.
        `$KV.${AUTH}.${gateKey}`,
        `$KV.${AUTH}.${credPrefix}.>`,
        ...recordKeys.map((k) => `$KV.${REC}.${k}`),
        // §13.7 contract-artifact publication (P2 item 1, 1c): the registration publishes the
        // endpoint's cluster document, closure manifests, and schema roots to the EPC store so
        // callers can fetch-verify-compile the registered digests. A digest subject is a SINGLE
        // hex token (`epc.<64hex>`), so the grant is the single-token `epc.*` form (matching
        // `contractPublisherGrants`), never the multi-token `epc.>`. Digest subjects cannot be
        // key-pinned pre-mint; the store's SHAPE is the defense (ensureContractStore): a digest
        // subject holds exactly one broker-immutable message (max_msgs_per_subject:1 +
        // discard-new-per-subject REJECTS a second publish regardless of the create-only header, so
        // a grant-holder CANNOT append a shadow over a published artifact), deny_delete/deny_purge
        // keep that message, and content addressing (verify-on-read, create-only-winner fallback)
        // makes a wrong-subject write unservable. NAMED RESIDUAL: for its one-shot lifetime the
        // executor can publish NEW digest-addressed artifacts at previously-unused subjects (a
        // bounded storage flood; unreferenced artifacts carry no authority) — it can NOT overwrite,
        // shadow, or replace an existing one.
        `${spacePrefix(space)}.epc.*`,
        // The lost-CAS verify-read `publishContractArtifact` runs when a re-publish (every re-up /
        // restart against an existing store) loses the create-only CAS: it fetches the recorded
        // artifact to confirm the idempotent no-op. BOTH Direct Get forms — the subject-scoped
        // `last_by_subj` (the fast path) and the bare stream form (the create-only-winner
        // `next_by_subj` fallback) — so the publish path never dies on a broker denial regardless
        // of stream config. Without this the manager exits on its SECOND boot (the tester's
        // upgrade-path regression). Reads public content-addressed artifacts only.
        `$JS.API.DIRECT.GET.${epcStreamName(space)}.${spacePrefix(space)}.epc.>`,
        `$JS.API.DIRECT.GET.${epcStreamName(space)}`,
        // Leader-served reads (the auth store is allow_direct=false): stream-scoped MSG.GET (the
        // barrier/fence read the gate + each epcred row), plus the ordered consumer the epcred
        // `keys()` enumeration binds. The records store IS direct-servable, so its reads add the
        // key-pinned DIRECT.GET forms beside the leader-served fallback. NAMED RESIDUAL: reads
        // any row in both stores for its one-shot lifetime (metadata, no bearer bytes).
        `$JS.API.STREAM.MSG.GET.KV_${AUTH}`,
        `$JS.API.CONSUMER.CREATE.KV_${AUTH}.>`,
        `$JS.API.CONSUMER.INFO.KV_${AUTH}.>`,
        `$JS.API.CONSUMER.DELETE.KV_${AUTH}.>`,
        ...recordKeys.map((k) => `$JS.API.DIRECT.GET.KV_${REC}.$KV.${REC}.${k}`),
        `$JS.API.STREAM.MSG.GET.KV_${REC}`,
      ],
    },
    sub: { allow: [`_INBOX_${pr.connId}.>`] },
  };
}

/** The ephemeral, TARGET-PINNED DEPROVISIONER permission set (#159 Part B) — the teardown counterpart
 *  to {@link provisionerPermissions}, minted per departed agent inside the manager's `deprovision` tail
 *  (`withProvisioner`-style: a fresh scoped cred per teardown is cheap). It deletes exactly the
 *  dev/static principal footprint the provisioner created for ONE agent: that agent's two bind-only
 *  durables (`dm_local-<actor>`, `dlv_local-<actor>`) and its read-ACL row — pinned BY NAME to the target
 *  actor under {@link DEV_OWNER}, so a leaked deprovisioner cred can tear down that one already-dead
 *  agent and NOTHING else.
 *
 *  Deliberately NOT granted (least-privilege / correctness): the role-SHARED `svc_<role>` TASK durable
 *  (one consumer for ALL agents of a role — deleting it on one agent's exit would break its siblings; it
 *  lives until space teardown), any peer's `dm_`/`dlv_`/ACL (the grants are target-name-pinned, never
 *  `.>`), any MSG.NEXT/MSG.GET/ACK (it deletes mailboxes, never reads a body), and any STREAM
 *  DELETE/PURGE (it removes per-agent consumers, never a stream). The `chathist_<id>` history consumers
 *  need no grant here — they are ephemeral (`mem_storage`, 30s inactive threshold) and agent-deleted
 *  after each read, so they self-clean on the agent's disconnect.
 *
 *  Blast radius of a leaked cred (minted for target T): it can delete T's `dm_local-<T>`/`dlv_local-<T>`
 *  durables + purge T's ACL row — a denial-of-DELIVERY for T (broken DM/DLV bind + the reader DEFERs on
 *  the absent ACL) if fired while T is still alive. It CANNOT read T's bodies, impersonate T, reach any peer, or
 *  delete a stream — and it is ephemeral (one per-exit teardown, minted then dropped). Contained and
 *  recoverable (re-provision T). */
function deprovisionerPermissions(space: string, pr: MintPrincipal, deprovisionTarget: DeprovisionTarget): Record<string, unknown> {
  const DM = dmStream(space), DLV = dlvStream(space);
  const t = deprovisionTargetPrincipal(deprovisionTarget);
  const target = principalKey(t.owner, t.actor);
  return {
    pub: {
      allow: [
        "$JS.API.INFO", // jetstreamManager bootstrap
        // Delete the target LIFECYCLE's two bind-only durables BY EXACT NAME — no `.>`, no cross-agent
        // reach, and no reach into a same-alias successor: its names carry a different uid, so a
        // replayed teardown is broker-DENIED there (SPEC 13.1 / Appendix "deprovisioner").
        `$JS.API.CONSUMER.DELETE.${DM}.${dmDurable(t.owner, t.actor, t.lifecycleUid)}`,
        `$JS.API.CONSUMER.DELETE.${DLV}.${dlvDurable(t.owner, t.actor, t.lifecycleUid)}`,
        // Purge the target lifecycle's read-ACL row (own-target exact key only — the reader then treats
        // it as an unknown owner). `kvm.open` binds the pre-created bucket; the purge rides
        // `$KV.<aclBucket>.<key>`.
        `$JS.API.STREAM.INFO.KV_${aclBucket(space)}`,
        `$KV.${aclBucket(space)}.${aclKey(target.key, t.lifecycleUid)}`,
      ],
    },
    // Replies only: the CONSUMER.DELETE PubAcks + KV purge ack land on the per-connection inbox. NO chat/DM/ctl
    // subscription — the deprovisioner serves nothing and reads no feed.
    sub: { allow: [`_INBOX_${pr.connId}.>`] },
  };
}

/** The scoped `delivery` daemon permission set (server-side Plane-3 infra; NEVER allow-all, never
 *  minted for an agent — `cotal mint` excludes it, like `manager`). Least-privilege: exactly what the
 *  fan-out writer + trusted reader + activation catch-up + membership/ACL reads + members-KV writes +
 *  the lease + the `ctl.delivery` control service touch. `sub.allow` is the per-identity inbox (all JS
 *  pull delivery / KV-watch / request replies land there) PLUS the `ctl.delivery` control subtree it
 *  serves; ALL stream/KV reads ride the JS API (publishes), so there is NO native `chat`/`dinbox`/`dlv`
 *  subscription — a leaked cred can't natively sniff the mixed pre-auth store. Honest blast radius
 *  (delivery-daemon.md): it can write any owner's `dlv` (the post-auth store agents trust); the future
 *  fan-out/reader cred split bounds that. */
function deliveryPermissions(space: string, pr: MintPrincipal): Record<string, unknown> {
  const p = spacePrefix(space);
  const CHAT = chatStream(space), INBOX = inboxStream(space), DLV = dlvStream(space);
  const PKV = `KV_${presenceBucket(space)}`, CHKV = `KV_${channelBucket(space)}`;
  const MKV = `KV_${membersBucket(space)}`, AKV = `KV_${aclBucket(space)}`, DKV = `KV_${deliveryBucket(space)}`;
  const kvRead = (bucket: string) => [
    `$JS.API.STREAM.INFO.${bucket}`,
    `$JS.API.STREAM.MSG.GET.${bucket}`, // kv.get
    `$JS.API.CONSUMER.CREATE.${bucket}.>`, // kv.watch ordered consumer
    `$JS.API.CONSUMER.INFO.${bucket}.>`,
    `$JS.API.CONSUMER.DELETE.${bucket}.>`,
  ];
  const pub = [
    "$JS.API.INFO",
    `$JS.API.STREAM.INFO.${CHAT}`, `$JS.API.STREAM.INFO.${INBOX}`, `$JS.API.STREAM.INFO.${DLV}`,
    // Fan-out durable + activation-catch-up ephemerals live on CHAT — the daemon legitimately reads ALL
    // chat (the fan-out consumes the whole stream), so a stream-wide CHAT consumer grant is no
    // escalation. The catch-up ephemeral names (`cu_<owner>_<gen>`) are dynamic, so they can't be
    // name-pinned; CHAT-wide is correct here.
    //
    // BOTH forms, and the bare one is not redundant: a create carrying `filter_subjects` cannot encode
    // its filter in the subject, so the client publishes to the BARE `…CREATE.<CHAT>` while a named
    // consumer goes to the `.>` form. The mediated history read (`readHistory`) builds exactly that
    // multi-filter ephemeral, and with only the `.>` grant it fails with a Permissions Violation on the
    // bare subject — measured, not predicted. The observer profile already carries both for the same
    // reason. Grants the daemon nothing new in substance: it may already create any named consumer on
    // this stream and already reads all of it.
    `$JS.API.CONSUMER.CREATE.${CHAT}`,
    `$JS.API.CONSUMER.CREATE.${CHAT}.>`,
    `$JS.API.CONSUMER.DURABLE.CREATE.${CHAT}.>`,
    `$JS.API.CONSUMER.INFO.${CHAT}.>`,
    `$JS.API.CONSUMER.MSG.NEXT.${CHAT}.>`,
    `$JS.API.CONSUMER.DELETE.${CHAT}.>`,
    `$JS.ACK.${CHAT}.>`,
    // Trusted reader on INBOX — NAME-PINNED to the single `reader` durable (the meaningful confinement:
    // no arbitrary INBOX consumer create against the mixed pre-auth store).
    `$JS.API.CONSUMER.CREATE.${INBOX}.${INBOX_READER_DURABLE}.>`,
    `$JS.API.CONSUMER.DURABLE.CREATE.${INBOX}.${INBOX_READER_DURABLE}`,
    `$JS.API.CONSUMER.INFO.${INBOX}.${INBOX_READER_DURABLE}`,
    `$JS.API.CONSUMER.MSG.NEXT.${INBOX}.${INBOX_READER_DURABLE}`,
    `$JS.API.CONSUMER.DELETE.${INBOX}.${INBOX_READER_DURABLE}`,
    `$JS.ACK.${INBOX}.${INBOX_READER_DURABLE}.>`,
    "$JS.FC.>", // ordered-consumer flow control
    // Reads: presence (@mention resolve) + channel registry (delivery class) + members + ACL (re-auth).
    ...kvRead(PKV), ...kvRead(CHKV), ...kvRead(MKV), ...kvRead(AKV),
    // Members-KV WRITE — the daemon is the durable-membership authority (join/leave/activate/catch-up).
    `$KV.${membersBucket(space)}.>`,
    // Delivery lease/readiness KV: read the bucket (renew CAS) + write ONLY lease keys.
    `$JS.API.STREAM.INFO.${DKV}`, `$JS.API.STREAM.MSG.GET.${DKV}`,
    `$KV.${deliveryBucket(space)}.lease.*`,
    // Plane-3 data writes: dinbox (fan-out target) + dlv (post-auth handoff) for ANY lifecycle — the
    // identity slots widen to `.*.*.*` (owner+actor+lifecycleUid: dinbox/dlv are per-LIFECYCLE now,
    // SPEC 13.1; NATS subject arity is exact, so the old two-token form is broker-denied on every
    // three-token write).
    `${p}.dinbox.*.*.*`, `${p}.dlv.*.*.*`,
    // ctl.delivery control REPLIES ONLY (requests arrive on the sub below; the daemon only ever
    // m.respond()s to a requester's reply subject `ctl.delivery.<owner>.<actor>.reply.<n>`). Scoped to
    // the `.reply.>` leaf so the daemon can't publish to the request subjects themselves — tighter than a
    // blanket `ctl.delivery.>` (fact-check precision, review panel). The caller slots widened to `.*.*`.
    `${p}.ctl.delivery.*.*.reply.>`,
    // The privileged delivery-admin rail (D5 slice 5/6): same replies-only shape. Requests reach the
    // daemon on the sub below; only the supervisor cred can PUBLISH them (nats-server is the boundary).
    `${p}.ctl.delivery-admin.*.*.reply.>`,
  ];
  const sub = [
    `_INBOX_${pr.connId}.>`,
    `${p}.ctl.delivery.*.*`, // serve the delivery control service (queue-grouped; owner+actor caller slots)
    `${p}.ctl.delivery-admin.*.*`, // serve the privileged admin rail (reloadCreds; eviction executor next)
  ];
  return { pub: { allow: pub }, sub: { allow: sub } };
}

/** The scoped DATA-account `membership-rw` permission set (the graph feed's conn B; NEVER allow-all,
 *  never minted for an agent — `cotal mint` excludes it, like `manager`/`delivery`). Least-privilege:
 *  READ the members registry (the durable arm of the merge) + READ/WRITE the one derived membership
 *  bucket, and nothing else. It holds NO chat/DM/anycast/ctl grant and never touches `$SYS` (account
 *  isolation keeps the system-account CONNZ read on the SEPARATE conn-A cred). A leaked conn-B cred can
 *  read durable-membership records and forge the feed — bounded to "dashboard integrity" by the
 *  display-only invariant; it reads no message bodies and admins nothing. */
function membershipRwPermissions(space: string, pr: MintPrincipal): Record<string, unknown> {
  const MKV = `KV_${membersBucket(space)}`; // durable arm — read
  const MEMKV = `KV_${membershipBucket(space)}`; // derived feed — read (diff/prune) + write
  const kvRead = (bucket: string) => [
    `$JS.API.STREAM.INFO.${bucket}`,
    `$JS.API.STREAM.MSG.GET.${bucket}`, // kv.get
    `$JS.API.CONSUMER.CREATE.${bucket}.>`, // kv.keys()/kv.watch ordered consumer
    `$JS.API.CONSUMER.INFO.${bucket}.>`,
    `$JS.API.CONSUMER.DELETE.${bucket}.>`,
  ];
  const pub = [
    "$JS.API.INFO",
    ...kvRead(MKV),
    ...kvRead(MEMKV),
    `$KV.${membershipBucket(space)}.>`, // write derived feed (kv.put + kv.delete)
    "$JS.FC.>", // ordered-consumer flow control
  ];
  return { pub: { allow: pub }, sub: { allow: [`_INBOX_${pr.connId}.>`] } };
}

/** The scoped SYSTEM-account `membership-observer` permission set (the graph feed's conn A). An EXPLICIT
 *  block is MANDATORY: a system-account user with NO permissions block defaults to ALLOW-ALL = full
 *  `$SYS` = broker admin (verified — pre-flight spike + docs). Least-privilege allowlist:
 *   - **pub:** the account-scoped CONNZ request subject ONLY (not server-wide `PING.CONNZ`, not
 *     `REQ.SERVER.*`/`REQ.CLAIMS.*`).
 *   - **sub:** the scoped reply inbox (`<MEMBERSHIP_INBOX_PREFIX>.>`) + this ONE account's
 *     CONNECT/DISCONNECT events (re-poll triggers) — never `$SYS.ACCOUNT.*.…` (cross-tenant) nor
 *     `$SYS.ACCOUNT.<id>.>` (pulls in SUBSZ/JSZ/purge).
 *  No `$SYS.>` deny that would shadow the allows (deny-beats-allow). A leaked conn-A cred enumerates THIS
 *  account's connections (silent readers + nkeys) and can forge the feed; it reads no bodies, touches no
 *  other account, and admins no server. */
function membershipObserverPermissions(accountId: string): Record<string, unknown> {
  return {
    pub: { allow: [connzRequestSubject(accountId)] },
    sub: {
      allow: [
        `${MEMBERSHIP_INBOX_PREFIX}.>`,
        accountConnectSubject(accountId),
        accountDisconnectSubject(accountId),
      ],
    },
  };
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
      "mintMembershipObserverCreds: no in-memory system-account signing seed - the observer can only be minted from a system account that is being (re)provisioned, because the $SYS seed is never persisted. Rotate the system account to mint a fresh one (`cotal down` then `cotal up --rotate-sys`); a plain re-`up` reuses the existing account and its existing creds.",
    );
  const signer = fromSeed(new TextEncoder().encode(auth.sys.signingSeed));
  const perms = membershipObserverPermissions(auth.account.pub);
  // Bounded exp (D5 slice 5): the observer is `rotation-renewed` — it carries the matrix's default
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

/** The KICK-ONLY connection-evictor permission set (D5 slice 4) — a SYSTEM-account user that can do
 *  exactly ONE thing: `$SYS.REQ.SERVER.*.KICK` (disconnect a live client by cid). It CANNOT read
 *  CONNZ (discovery stays on the separate observer cred — never one broad sys user that both
 *  enumerates and kills), touch any other `$SYS` verb, or reach another account's data. A leaked
 *  evictor cred can DoS live connections on this broker (KICK is not account-scoped — the honest
 *  blast radius), which is why it is a HIGH-POWER standing credential: minted only at `up`,
 *  rate-limited + audited by its one caller (the delivery daemon), and its cid/server-id inputs come
 *  only from the observer's own CONNZ scan, never a user-facing API. Wildcard `*` over server id
 *  because a cluster's server ids aren't known at mint time; the scan pins the exact id per KICK. */
function connectionEvictorPermissions(): Record<string, unknown> {
  return {
    pub: { allow: ["$SYS.REQ.SERVER.*.KICK"] },
    // Request/reply KICK replies land on the client's default inbox; no other subscription — it
    // serves nothing and reads no feed.
    sub: { allow: ["_INBOX.>"] },
  };
}

/** Mint the scoped `connection-evictor` creds — the kick-only SYSTEM-account user D5 slice 4's live
 *  eviction holds. Same mint-only-at-provision property as the observer (the $SYS seed is in-memory
 *  only), same fail-loud when it's absent. Paired with the observer at `up`. */
export async function mintConnectionEvictorCreds(auth: SpaceAuth, identity: Identity, opts: MintOpts = {}): Promise<string> {
  if (!auth.sys.signingSeed)
    throw new Error(
      "mintConnectionEvictorCreds: no in-memory system-account signing seed - the evictor can only be minted from a system account that is being (re)provisioned, because the $SYS seed is never persisted. Rotate the system account to mint a fresh one (`cotal down` then `cotal up --rotate-sys`); a plain re-`up` reuses the existing account and its existing creds.",
    );
  const signer = fromSeed(new TextEncoder().encode(auth.sys.signingSeed));
  // Bounded exp (D5 slice 5): `rotation-renewed`, same posture as the observer above.
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

/** Render the `nats-server` config that trusts ONE broker operator and serves N spaces' accounts via
 *  the in-config MEMORY resolver.
 *
 *  Broker trust (operator + system account) comes from `broker` and has exactly one owner; the
 *  per-space data accounts are listed in `spaces`. Every space account is asserted to be signed by
 *  THIS broker's operator before it is preloaded: rendering a foreign-signed account would either
 *  refuse broker boot or, worse, advertise a tenant the broker cannot actually authenticate.
 *
 *  NOTE (W4): the MEMORY resolver is one static whole-broker map, so every mutation rewrites all of
 *  it. Concurrent add/remove of spaces needs a broker-authoritative inventory with generation/CAS
 *  and atomic promotion above this function; this renderer is deliberately pure. */
/**
 * Render the config for an OPEN (no-auth) broker.
 *
 * This exists so that no path reaches a listener without naming its transport. Open mode used to
 * start nats-server from bare CLI flags (`-js -sd … -p … -a …`) and never called `serverConfig` at
 * all, which meant the required `transport` union protected the auth path and was silent on the
 * open one: an operator could pass a cert and key, watch `up` print its normal banner, and get a
 * cleartext listener. That is the silent downgrade this feature exists to prevent, reachable by
 * someone who did everything right — so open mode renders a config too.
 *
 * It deliberately does NOT reuse `serverConfig`: that renders the operator, system account and
 * MEMORY resolver, none of which a no-auth broker should carry. What the two share is the thing
 * that matters — a REQUIRED transport, so the choice cannot be omitted on either path.
 *
 * IMPORTANT, and it must be said wherever open-mode TLS is surfaced to an operator: TLS ON AN
 * OPEN MESH GIVES CONFIDENTIALITY, NOT AUTHENTICATION. It hides traffic from a passive observer.
 * It does not verify who is connecting, because an open broker has no credentials to check — so
 * anyone who can reach the port still gets in, encrypted. It is a legitimate configuration for a
 * mesh crossing a network nobody controls, and it is NOT "secure" in the sense a reader will
 * assume from seeing `cotals://`. Describe it as the caveat it is rather than as a feature.
 */
export function openServerConfig(opts: {
  port?: number;
  host?: string;
  storeDir: string;
  transport: BrokerTransport;
}): string {
  const port = opts.port ?? 4222;
  const host = opts.host ?? "127.0.0.1";
  return `# Generated by \`cotal up\` - do not edit by hand.
host: ${host}
port: ${port}
max_control_line: 65536
${renderTlsBlock(opts.transport)}jetstream { store_dir: ${JSON.stringify(opts.storeDir)} }
`;
}

/** The one place a `tls{}` block is produced, shared by both broker renderers.
 *
 *  `allow_non_tls` is deliberately never emitted. It is a TOP-LEVEL knob (nested inside `tls{}`
 *  nats-server rejects it as an unknown field), and it turns the listener into mixed mode: INFO
 *  then advertises `tls_available` instead of `tls_required`, and a client that declines to
 *  upgrade is served in cleartext — precisely the credential exposure this transport closes.
 *  There is no supported migration mode; enabling TLS is all-or-nothing. */
function renderTlsBlock(transport: BrokerTransport): string {
  if (transport.kind === "plaintext") return "";
  return `tls {
  cert_file: ${JSON.stringify(transport.certFile)}
  key_file: ${JSON.stringify(transport.keyFile)}
}
`;
}

export function serverConfig(
  broker: BrokerAuth,
  spaces: readonly SpaceAccountAuth[],
  opts: {
    port?: number;
    host?: string;
    storeDir: string;
    /** Additional operator-signed accounts to preload in the MEMORY resolver — e.g. the dedicated
     *  auth-callout account (`@cotal-ai/auth`), which must never share the data account. */
    extraAccounts?: Array<{ pub: string; jwt: string }>;
    /** How the client port is served. REQUIRED, and required on purpose: an optional TLS field
     *  would let any future path that regenerates this config omit it and silently render a
     *  plaintext listener. Callers must say `{ kind: "plaintext" }` when that is what they mean.
     *  TLS is listener-wide, so it lives here in the broker options rather than per space —
     *  no space can enable, disable or rotate it independently. */
    transport: BrokerTransport;
    /** OPT-IN NATS websocket listener port (P2 item 6): browsers cannot speak raw NATS TCP, so the
     *  console session client (a real mesh caller) needs one. This is a NEW ATTACK SURFACE the broker
     *  did not have — emitted only when set, DEFAULT-BOUND TO LOCALHOST ({@link wsHost}), no TLS
     *  (dev loopback; a remote/TLS dashboard is a later explicit opt-in). Omit it and no listener
     *  exists (a broker with no console need adds no surface). */
    wsPort?: number;
    /** Bind host for the websocket listener; defaults to loopback. Widening it (a remote dashboard)
     *  is a deliberate operator choice, never the default. */
    wsHost?: string;
  },
): string {
  if (!spaces.length) throw new Error("serverConfig: at least one space account is required");
  for (const s of spaces) assertAccountSignedByBroker(broker, s);
  const seen = new Map<string, string>();
  for (const s of [...spaces.map((s) => ({ pub: s.account.pub, what: `space "${s.space}"` })), ...(opts.extraAccounts ?? []).map((a) => ({ pub: a.pub, what: "an extra account" }))]) {
    const prior = seen.get(s.pub);
    if (prior) throw new Error(`serverConfig: account ${s.pub} is preloaded twice (${prior} and ${s.what}) - refusing to render an ambiguous resolver`);
    seen.set(s.pub, s.what);
  }
  const port = opts.port ?? 4222;
  const host = opts.host ?? "127.0.0.1";
  // The websocket listener (item 6): LOCALHOST by default, no_tls for the dev loopback. Emitted only
  // when wsPort is set — a broker with no console session client opens no ws surface.
  const websocket = opts.wsPort === undefined ? "" : `websocket {
  host: ${opts.wsHost ?? "127.0.0.1"}
  port: ${opts.wsPort}
  no_tls: true
}
`;
  // A minted "agent" carries its full permission allow-list inline in its user JWT, which the
  // client sends in the CONNECT protocol line. With per-channel + JetStream-API grants that JWT
  // exceeds the 4 KB default max_control_line at ~2 channels, and the server then silently drops
  // the connection (the client retries forever — a connect that "hangs"). Raise it to fit a rich
  // agent JWT — but right-sized, not generous: the CONNECT line is parsed BEFORE auth, so the cap
  // is a per-connection pre-auth allocation under connection flooding. 64 KB clears a many-channel
  // agent JWT (~4–8 KB) with wide margin while keeping the pre-auth surface ~16× tighter than 1 MB.
  const tlsBlock = renderTlsBlock(opts.transport);
  return `# Generated by \`cotal up\` - do not edit by hand.
host: ${host}
port: ${port}
max_control_line: 65536
${tlsBlock}jetstream { store_dir: ${JSON.stringify(opts.storeDir)} }
${websocket}operator: ${broker.operator.jwt}
system_account: ${broker.sys.pub}
resolver: MEMORY
resolver_preload: {
${spaces.map((s) => `  ${s.account.pub}: ${s.account.jwt}`).join("\n")}
  ${broker.sys.pub}: ${broker.sys.jwt}${(opts.extraAccounts ?? []).map((a) => `\n  ${a.pub}: ${a.jwt}`).join("")}
}
`;
}
