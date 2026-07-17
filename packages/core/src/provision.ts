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
import { join } from "node:path";
import {
  encodeOperator,
  encodeAccount,
  encodeUser,
  fmtCreds,
} from "@nats-io/jwt";
import { createOperator, createAccount, fromPublic, fromSeed } from "@nats-io/nkeys";
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
  CONTROL_PRIVILEGED,
  CONTROL_SELF_SERVICE,
  CONTROL_ADMIN,
  CONTROL_DELIVERY,
  CONTROL_DELIVERY_ADMIN,
  type ControlTier,
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
import { epCallerGrantRows, epServeGrantRows, epBaselineGrantRows, spawnCallerCapabilities, type EpCapability } from "./endpoint-grants.js";
import { assertServeGrantMintable, finalizeServeIssuance, type EpServeGrant, type EpIssuanceGate } from "./endpoint-service.js";
import { effectsBindGrants, poolOwnerBindGrants } from "./endpoint-binding.js";
import { rawDigest } from "./canonical.js";
import { credsClaims, type Identity } from "./identity.js";

/** Cred profiles. Each profile has an explicit permission arm and a D5 lifetime classification. */
export type Profile =
  | "agent"
  | "observer"
  | "admin"
  | "supervisor"
  | "provisioner"
  | "deprovisioner" // ephemeral, TARGET-PINNED teardown of ONE departed agent's id-keyed footprint (#159 B)
  | "operator"
  | "purger"
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
  | "endpoint-serve";

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
  "membership-rw": { class: "standing-renewable", defaultTtlSeconds: STANDING_RENEWABLE_TTL_SEC, renewalOwner: "manager", note: "membership feed writer; seed-less - the manager re-signs .cotal/membership-rw.creds for the SAME nkey, delivery-admin reloadCreds reconnects the rw feed explicitly, and source re-read is only a backstop (D5 slice 5 class 2)" },
  provisioner: { class: "one-shot", defaultTtlSeconds: FIVE_MINUTES, note: "setup/spawn provisioning window only" },
  deprovisioner: { class: "one-shot", defaultTtlSeconds: FIVE_MINUTES, note: "target-pinned teardown window only" },
  operator: { class: "one-shot", defaultTtlSeconds: FIVE_MINUTES, note: "send/dm/join/probe-style operator command" },
  purger: { class: "one-shot", defaultTtlSeconds: FIVE_MINUTES, note: "history purge command" },
  probe: { class: "one-shot", defaultTtlSeconds: 60, note: "connect-only preflight" },
  "channel-writer": { class: "one-shot", defaultTtlSeconds: FIVE_MINUTES, note: "channel registry mutation command" },
  "channel-purger": { class: "mixed", note: "one-shot for CLI, standing inside web; split or renewal required before default exp" },
  teardown: { class: "one-shot", note: "space teardown can be long/destructive; needs TTL budget/remint guard before default exp" },
  "control-caller-privileged": { class: "one-shot", defaultTtlSeconds: FIVE_MINUTES, note: "ps/start control call" },
  "control-caller-admin": { class: "one-shot", defaultTtlSeconds: FIVE_MINUTES, note: "stop/attach admin control call" },
  deployer: { class: "one-shot", note: "manifest deploy spans planning/launch/ledger; needs near-expiry guard or remint before default exp" },
  "endpoint-serve": { class: "standing-renewable", defaultTtlSeconds: STANDING_RENEWABLE_TTL_SEC, renewalOwner: "manager", note: "per-instance endpoint serve credential (SPEC 13.9); the managing authority re-mints on renewal and on takeover (new epoch), and the 13.1 barrier revokes the superseded one" },
  "membership-observer": { class: "rotation-renewed", defaultTtlSeconds: ROTATION_RENEWED_TTL_SEC, renewalOwner: "system-account rotation", note: "$SYS-account CONNZ observer; NOT online-renewable ($SYS seed dies at `up`) - bounded exp, renewed only by rotateSystemAccount + broker restart; doctor warns near expiry" },
  "connection-evictor": { class: "rotation-renewed", defaultTtlSeconds: ROTATION_RENEWED_TTL_SEC, renewalOwner: "system-account rotation", note: "$SYS-account KICK-only live-eviction cred (D5 slice 4); same rotation-renewed posture as the observer" },
};

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

/** A space's persisted trust material. The `signingSeed` is the sensitive provisioner
 *  secret; everything else is public (JWTs) or recoverable. The system-account `signingSeed` is the ONE
 *  field {@link saveSpaceAuth} never writes to disk — it lives only in memory, just long enough at `cotal
 *  up` to mint the scoped membership-observer cred (see {@link mintMembershipObserverCreds}). */
export interface SpaceAuth {
  space: string;
  operator: { seed: string; jwt: string };
  account: { pub: string; seed: string; jwt: string; signingSeed: string; signingPub: string };
  /** `signingSeed` is in-memory only (a fresh {@link createSpaceAuth}); NEVER persisted — minting a
   *  system-account user is broker-admin capability, so no standing `$SYS` seed is left on disk. */
  sys: { pub: string; jwt: string; signingSeed?: string };
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
  return {
    ...auth,
    operator: { ...auth.operator, jwt: operatorJwt },
    sys: { pub: sysPub, jwt: sysJwt, signingSeed: new TextDecoder().decode(syskp.getSeed()) },
  };
}

/** Generate a fresh operator → account(+signing key) → system-account chain for a space. */
export async function createSpaceAuth(space: string): Promise<SpaceAuth> {
  const okp = createOperator();
  const akp = createAccount();
  const askp = createAccount(); // account signing key — what mints users
  const syskp = createAccount();
  const sysPub = syskp.getPublicKey();

  const operatorJwt = await encodeOperator(`cotal-${token(space)}`, okp, { system_account: sysPub });
  const accountJwt = await encodeAccount(
    token(space),
    akp,
    { signing_keys: [askp.getPublicKey()], limits: DATA_LIMITS },
    { signer: okp },
  );
  const sysJwt = await encodeAccount("SYS", syskp, { limits: SYS_LIMITS }, { signer: okp });

  const dec = (u: Uint8Array) => new TextDecoder().decode(u);
  return {
    space,
    operator: { seed: dec(okp.getSeed()), jwt: operatorJwt },
    account: {
      pub: akp.getPublicKey(),
      seed: dec(akp.getSeed()),
      jwt: accountJwt,
      signingSeed: dec(askp.getSeed()),
      signingPub: askp.getPublicKey(),
    },
    // `signingSeed` carried in-memory ONLY (stripped by saveSpaceAuth) — the single window in which the
    // scoped membership-observer system-account user can be minted (see mintMembershipObserverCreds).
    sys: { pub: sysPub, jwt: sysJwt, signingSeed: dec(syskp.getSeed()) },
  };
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
  /** Control service the agent may address. Defaults to `"manager"`. */
  manager?: string;
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
  /** `deployer` profile only: which control tier its `launch`/`ps` calls ride. Defaults to
   *  {@link CONTROL_ADMIN} (the static operator's ephemeral deploy cred). The user-mode `deployer`
   *  VIEW mints {@link CONTROL_PRIVILEGED} instead, so a spawn-scoped deploy reaches the manager
   *  where its owner-equality launch authorization governs — never the admin-tier bypass. Ignored
   *  by every other profile. */
  controlTier?: ControlTier;
  /** Override the profile default lifetime. Internal/test hook; command surfaces should prefer the
   * centralized {@link CREDENTIAL_LIFETIMES} defaults so profile behavior stays auditable. */
  expiresInSeconds?: number;
  /** Absolute JWT `exp` timestamp in seconds. Used by cutover/test code that needs already-expired creds. */
  expiresAt?: number;
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
  const ttl = opts.expiresInSeconds ?? CREDENTIAL_LIFETIMES[kind].defaultTtlSeconds;
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
   *  delivery at frontier+1 (SPEC :467) — a same-alias successor inherits no predecessor DMs.
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
 *  via the server-side delivery daemon's `ctl.delivery` op at connect. A live-only launcher
 *  (`durableMembership:false`, e.g. direct `cotal spawn`) gets no ACL row and stays live-only. */
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
  // daemon at connect (no manager-written boot membership). `durableMembership:false` (a live-only
  // launcher, e.g. direct `cotal spawn` with no daemon) opts out of the ACL row → the daemon never
  // authorizes a durable backstop for it, so it stays live-only.
  // ACL is keyed by the lifecycle-scoped dot-form <owner>.<actor>.<uid> (per-incarnation read authority).
  if (opts.durableMembership !== false) await provisioner.commitAcl(principalKey(pr.owner, pr.actor).key, uid, allowSubscribe);
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
  if (profile === "purger") return purgerPermissions(space, pr); // ephemeral history-purge (closure (ii))
  if (profile === "operator") return operatorPermissions(space, pr); // human-CLI client (send/dm/ask) (closure (ii))
  if (profile === "probe") return probePermissions(pr); // connect-only liveness/auth preflight (PR 1.5)
  if (profile === "channel-writer") return channelWriterPermissions(space, pr); // channel-registry writes (PR 1.5)
  if (profile === "channel-purger") return channelPurgerPermissions(space, pr); // channel-writer + CHAT purge (PR 1.5)
  if (profile === "teardown") return teardownPermissions(space, pr); // sole STREAM.DELETE holder (PR 1.5)
  if (profile === "control-caller-privileged") return controlCallerPermissions(space, pr, CONTROL_PRIVILEGED); // ps/start (PR 1.5)
  if (profile === "control-caller-admin") return controlCallerPermissions(space, pr, CONTROL_ADMIN); // stop/attach (PR 1.5)
  if (profile === "deployer") return deployerPermissions(space, pr, opts.controlTier ?? CONTROL_ADMIN); // spawn -f deploy authority (PR 1.5; user-mode view rides privileged)
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
  const manager = opts.manager ?? CONTROL_PRIVILEGED;
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
    controlServiceSubject(space, CONTROL_SELF_SERVICE, pr.owner, pr.actor), // ctl.self.<o>.<a> — self stop/despawn
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
  if (opts.capabilities?.includes("spawn")) {
    // Spawn capability → grant the PRIVILEGED control subject (start / purge / definePersona /
    // named stop-despawn). Default-deny otherwise: the subject is simply absent from this
    // allow-list, so nats-server rejects the publish — no handler check, no deny-entry (a
    // blanket `ctl.<mgr>.>` deny would override this grant too, since NATS deny beats allow).
    // The self-service subject above is granted to all regardless of capability.
    pubAllow.push(controlServiceSubject(space, manager, pr.owner, pr.actor));
  }
  if (opts.capabilities?.includes("admin")) {
    // Admin capability → the ADMIN control tier (cross-agent stop/attach, manifest launch). In user
    // mode this arrives via the ledger row's scope (`cotal actor grant … --scope admin`) — the
    // broker-enforced half of the tier split; the manager's per-op checks stay on top of it.
    pubAllow.push(controlServiceSubject(space, CONTROL_ADMIN, pr.owner, pr.actor));
  }
  // v0.4 endpoint rails (SPEC §13.9 caller rows). EVERY agent gets the Appendix-B BASELINE set
  // (wildcard describe + delivery join/leave/list + self-mode lifecycle + the reply rail), keyed
  // on the SAME lifecycle uid as the agent's durables; the spawn capability adds the owner-mode
  // manager lifecycle set. Beyond the baseline stays default-deny: only minted capabilities
  // produce rows, each pinning the full caller triple (§13.1 lifecycle UID included; the nonce
  // is the only wildcard token).
  const epCaller = { owner: pr.owner, actor: pr.actor, uid };
  const baseline = epBaselineGrantRows(space, epCaller);
  pubAllow.push(...baseline.pub);
  const epSub: string[] = [...baseline.sub];
  if (opts.capabilities?.includes("spawn"))
    pubAllow.push(...epCallerGrantRows(space, spawnCallerCapabilities(pr.owner), epCaller).pub);
  if (opts.endpointCapabilities?.length) {
    if (!opts.lifecycleUid)
      throw new Error("permissionsFor: endpointCapabilities require a lifecycleUid - the caller triple pins it at mint time (SPEC 13.1/13.2)");
    const rows = epCallerGrantRows(space, opts.endpointCapabilities, { owner: pr.owner, actor: pr.actor, uid: opts.lifecycleUid });
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
  // Bounded control replies (closure (i)): the manager's lifecycle tiers now reply on
  // `ctl.<tier>.<id>.reply.>` (not the per-id `_INBOX`), so each agent must subscribe the reply subtree
  // for the tiers it may call. Every agent can self-stop ⇒ always grant the self tier; the privileged /
  // admin tiers' replies are granted only with the matching capability (which also grants the request
  // publish above).
  const controlReplies = [`${controlServiceSubject(space, CONTROL_SELF_SERVICE, pr.owner, pr.actor)}.reply.>`];
  if (opts.capabilities?.includes("spawn"))
    controlReplies.push(`${controlServiceSubject(space, CONTROL_PRIVILEGED, pr.owner, pr.actor)}.reply.>`);
  if (opts.capabilities?.includes("admin"))
    controlReplies.push(`${controlServiceSubject(space, CONTROL_ADMIN, pr.owner, pr.actor)}.reply.>`);
  return { pub: { allow: pubAllow, deny: pubDeny }, sub: { allow: [inbox, deliveryReplies, ...controlReplies, ...subChat, ...epSub] } };
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
 *  leaked supervisor cred can hold/serve control and read the public roster; it cannot read a DM, forge an
 *  actor, provision, purge, or tamper with a stream. */
function supervisorPermissions(space: string, pr: MintPrincipal): Record<string, unknown> {
  const PKV = `KV_${presenceBucket(space)}`, MKV = `KV_${managerBucket(space)}`;
  // The three SERVED lifecycle tiers (manager.ts serveControl): subscribe `ctl.<tier>.*.*` (queue-grouped,
  // the owner+actor caller slots widened from one token to two) and reply on the bounded
  // `ctl.<tier>.<owner>.<actor>.reply.<uuid>` subtree. Plain NATS request/reply — no `$JS.ACK`.
  const tiers = [CONTROL_PRIVILEGED, CONTROL_SELF_SERVICE, CONTROL_ADMIN];
  const ctlServe = tiers.map((t) => controlServiceSubject(space, t, "*", "*")); // ctl.<tier>.*.*
  const ctlReplies = tiers.map((t) => `${controlServiceSubject(space, t, "*", "*")}.reply.>`);
  return {
    pub: {
      allow: [
        "$JS.API.INFO",
        // Singleton manager lease (managerBucket, pre-created at `cotal up`): OPEN-ONLY bind + CAS the one
        // lease key (acquire/renew/release) + read it. NO STREAM.CREATE (pre-created), DELETE, or PURGE.
        `$JS.API.STREAM.INFO.${MKV}`,
        `$JS.API.STREAM.MSG.GET.${MKV}`, // readManagerLease + CAS-conflict kv.get (auth-mode kvm.open ⇒ MSG.GET)
        `$KV.${managerBucket(space)}.${MANAGER_LEASE_KEY}`, // the SINGLE lease key (create/update/delete = $KV publishes)
        // Presence: publish OWN key + watch the roster. Own key only (no peer-key forge — residual 3); no
        // presence-stream purge/delete (no force-offline tamper). No presence kv.get (roster is the in-memory
        // watch cache + sweep), so no STREAM.MSG.GET on presence.
        `$KV.${presenceBucket(space)}.${principalKey(pr.owner, pr.actor).key}`,
        `$JS.API.STREAM.INFO.${PKV}`,
        `$JS.API.CONSUMER.CREATE.${PKV}.>`, // kv.watch ordered consumer (roster)
        `$JS.API.CONSUMER.INFO.${PKV}.>`,
        "$JS.FC.>", // ordered-consumer flow control
        // Control: reply to any caller on each SERVED tier (bounded). It SERVES (does not call), so no
        // request-publish grant and no position-1 wildcard — EXCEPT the delivery-admin rail below.
        ...ctlReplies,
        // The ONE control service the supervisor CALLS (D5 slice 5): the delivery daemon's privileged
        // admin rail — the manager is the class-2 renewal owner, and after re-signing the daemon creds
        // files it requests `reloadCreds` here so adoption is an explicit, auditable event. Self-scoped
        // request subject (its own owner+actor slots), bounded reply subtree in sub.allow below.
        controlServiceSubject(space, CONTROL_DELIVERY_ADMIN, pr.owner, pr.actor),
      ],
    },
    sub: {
      // Own reply inbox + the three served control tiers (queue-grouped) + the delivery-admin reply
      // subtree for its OWN requests. NO chat/inst/dlv native sub (the supervisor reads no feed), NO
      // broad `$JS.>`/`$KV.>` (the residual-2 read/admin path is gone).
      allow: [`_INBOX_${pr.connId}.>`, ...ctlServe, `${controlServiceSubject(space, CONTROL_DELIVERY_ADMIN, pr.owner, pr.actor)}.>`],
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
 *  → `requestControl(CONTROL_ADMIN, ps/stop)` to politely stop the managed agents → `deleteChannels`
 *  (channel-registry key delete + CHAT purge) → `deleteSpace` (STREAM.DELETE all 12 space streams/buckets).
 *  So it reads state, CALLS admin control, deletes channels, and deletes streams — but NEVER reads a
 *  DM/DLV body, posts chat, or forges. Isolated here so no standing operator/provisioner/supervisor cred
 *  can delete a stream; a leaked teardown can wipe a space you own + stop its agents (that IS its job),
 *  nothing else. Minted ephemerally per teardown from the local trust material (same-checkout `down -f`). */
function teardownPermissions(space: string, pr: MintPrincipal): Record<string, unknown> {
  const CHAT = chatStream(space);
  const PKV = `KV_${presenceBucket(space)}`, CHKV = `KV_${channelBucket(space)}`;
  // deleteSpace() deletes EVERY stream + KV bucket setup creates (5 streams + 7 buckets); each needs
  // INFO (jsm existence) + DELETE. This is the ONLY cred that holds STREAM.DELETE (face-b isolated here).
  const del = [
    CHAT, dmStream(space), taskStream(space), inboxStream(space), dlvStream(space),
    PKV, CHKV, `KV_${membersBucket(space)}`, `KV_${aclBucket(space)}`,
    `KV_${membershipBucket(space)}`, `KV_${deliveryBucket(space)}`, `KV_${managerBucket(space)}`,
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
        // Stop the managed agents via the admin control tier (ps + per-agent stop).
        controlServiceSubject(space, CONTROL_ADMIN, pr.owner, pr.actor),
        ...del,
        // deleteChannels/clearChannel: purge the channel's chat messages + delete its registry key.
        `$JS.API.STREAM.PURGE.${CHAT}`,
        `$KV.${channelBucket(space)}.>`,
      ],
    },
    // Own inbox (connectProbe presence-watch delivery + JS API responses) + the BOUNDED admin control-reply
    // subtree: the agent-stop step is `requestControl(CONTROL_ADMIN, ps/stop)`, whose reply rides
    // `ctl.admin.<id>.reply.<uuid>` (NOT `_INBOX`) — without this grant those calls hang and the agents are
    // never stopped before the streams are deleted.
    sub: { allow: [`_INBOX_${pr.connId}.>`, `${controlServiceSubject(space, CONTROL_ADMIN, pr.owner, pr.actor)}.reply.>`] },
  };
}

/** CONTROL-CALLER (PR 1.5) — the operator's lifecycle commands (`cotal ps/start/stop/attach`,
 *  `manager/commands.ts`). It CALLS ONE of the running manager's control tiers and reads the bounded
 *  reply on its own inbox. That is ALL — no `$JS`, no `$KV`, no chat/DM: it forges nothing, reads no body.
 *
 *  The tiers are SPLIT because the manager's control authz is SUBJECT-gated, NOT caller-identity-gated
 *  (`manager.ts authorizeNamed`: `if (admin) return undefined` — ANY caller reaching `ctl.<admin>` may
 *  stop/attach ANY agent; the privileged tier restricts named ops to the caller's OWN spawned child).
 *  So the BROKER grant is load-bearing: holding `ctl.<admin>.<id>` pub *is* cross-agent stop/attach
 *  power — the manager does not re-narrow it by `req.from.id`. Therefore:
 *   • `control-caller-privileged` (ps/start) gets ONLY `ctl.<privileged>.<id>` — structurally barred from
 *     cross-agent admin ops by the broker. This is the high-frequency path; it never needs admin reach.
 *   • `control-caller-admin` (stop/attach) gets ONLY `ctl.<admin>.<id>` — it genuinely needs cross-agent
 *     reach. Its containment is NOT a manager re-check (there is none): it is the broker gating the admin
 *     subject + the cred being ephemeral (mint → one request → disconnect, from the local signing seed). */
function controlCallerPermissions(space: string, pr: MintPrincipal, tier: string): Record<string, unknown> {
  const reqSubject = controlServiceSubject(space, tier, pr.owner, pr.actor);
  return {
    pub: { allow: [reqSubject] }, // exactly ONE tier — ps/start XOR stop/attach
    // Own inbox + the BOUNDED control-reply subtree. `requestControl` issues a `noMux` request whose reply
    // rides `ctl.<tier>.<id>.reply.<uuid>` (UNDER its own request subject, NOT `_INBOX`), so it must be able
    // to subscribe that subtree — without this grant the reply sub is broker-denied and every control call
    // hangs to timeout (endpoint.ts:803-806 predicts exactly this).
    sub: { allow: [`_INBOX_${pr.connId}.>`, `${reqSubject}.reply.>`] },
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
 *  membership feed, manager-singleton lease) AND control-CALLS the running manager's admin tier
 *  (`launch` + `ps` readiness — both `CONTROL_ADMIN`). Those interleave on one connection, so a strict
 *  3-connection split would only refactor `live.ts` for marginal gain; `deployer` is that one coherent,
 *  ephemeral deploy cred. It is the SOLE profile that combines reads + admin-control — NOT a template a
 *  4th command should reach for (revisit the connection split before adding a second such caller).
 *
 *  Boundaries (all enforced by omission / default-deny): NO self-post (`chat`/`inst`/`svc`), NO `$JS.>`,
 *  NO `STREAM.DELETE`/`PURGE`/`UPDATE`, NO DM/DLV/TASK `CONSUMER.CREATE` (no body-read surface), NO `$KV`
 *  writes (channel seeding rides a SEPARATE `channel-writer` cred), admin tier ONLY (no privileged, no
 *  serve). It holds `ctl.<admin>.<id>` because manifest launch/ps genuinely need the admin tier — and
 *  that IS real cross-agent power: the manager's admin authz is subject-gated, not caller-identity-gated
 *  (`authorizeNamed`: `if (admin) return undefined`), so holding the admin pub grant lets it stop/attach/
 *  launch ANY agent, with no manager-side `req.from.id` re-check. The BROKER gating that subject is the
 *  boundary. Containment is therefore the LIFETIME, not a manager re-check: minted from LOCAL same-checkout
 *  auth for one `spawn -f`, memory-only, dropped after deploy. If it is ever persisted, handed to
 *  user-supplied `--creds`, or reused as a general "read + admin" cred, revisit. */
function deployerPermissions(space: string, pr: MintPrincipal, tier: ControlTier = CONTROL_ADMIN): Record<string, unknown> {
  const PKV = `KV_${presenceBucket(space)}`, CHKV = `KV_${channelBucket(space)}`;
  const MSHIP = `KV_${membershipBucket(space)}`, MGRKV = `KV_${managerBucket(space)}`;
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
        "$JS.FC.>", // ordered-consumer flow control
        // ONE control tier — launch + ps readiness. Static operator deploy creds ride CONTROL_ADMIN
        // (the historical shape); the user-mode `deployer` VIEW rides CONTROL_PRIVILEGED so the
        // manager's owner-equality launch authorization governs (never the admin-tier bypass).
        controlServiceSubject(space, tier, pr.owner, pr.actor),
      ],
    },
    // Own inbox (presence/registry watch delivery + JS API responses) + the BOUNDED control-reply
    // subtree for the same tier: `requestControl(tier, launch/ps)` subscribes `ctl.<tier>.<id>.reply.<uuid>`,
    // so without this grant the launch + ps-readiness calls hang to timeout.
    sub: { allow: [`_INBOX_${pr.connId}.>`, `${controlServiceSubject(space, tier, pr.owner, pr.actor)}.reply.>`] },
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
 *  DM/DLV (it creates the bind-only mailbox but never reads it), NO STREAM.DELETE/PURGE/UPDATE/MSG.DELETE
 *  (it provisions, it does not tear down or tamper). KV value-writes are scoped to exactly the two
 *  registries provisioning touches: the read-ACL bucket (`commitAcl`) and the channel registry (seed). */
function provisionerPermissions(space: string, pr: MintPrincipal): Record<string, unknown> {
  const CHAT = chatStream(space), DM = dmStream(space), TASK = taskStream(space);
  const INBOX = inboxStream(space), DLV = dlvStream(space);
  // Every backing stream the provisioner pre-creates — the 5 message streams + the KV buckets (a bucket's
  // backing stream is `KV_<bucket>`). `managerBucket` is now pre-created here too (so the supervisor binds
  // its lease open-only); members/membership/delivery are written by other creds but created at setup here.
  const buckets = [
    presenceBucket, channelBucket, membersBucket, aclBucket, membershipBucket, deliveryBucket, managerBucket,
  ].map((b) => `KV_${b(space)}`);
  // STREAM.CREATE + INFO for each (idempotent setup at `cotal up`; CREATE is create-if-matching, INFO covers
  // the client's existence checks). NO DELETE/PURGE/UPDATE — provisioning never tears a stream down.
  const streamSetup = [CHAT, DM, TASK, INBOX, DLV, ...buckets].flatMap((s) => [
    `$JS.API.STREAM.CREATE.${s}`,
    `$JS.API.STREAM.INFO.${s}`,
  ]);
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
      ],
    },
    // Replies only: every stream/consumer/KV-create PubAck and JS API response lands on the per-id inbox.
    // NO chat/inst/dlv/ctl subscription — the provisioner never serves control nor reads any feed.
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
      "mintMembershipObserverCreds: no in-memory system-account signing seed - the observer can only be minted at the `up` that provisions the account (the $SYS seed is never persisted). Re-provision (down/up) to enable broker-sourced membership.",
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
      "mintConnectionEvictorCreds: no in-memory system-account signing seed - the evictor can only be minted at the `up` that provisions the account (the $SYS seed is never persisted). Re-provision (down/up) to enable live eviction.",
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

/** Render the `nats-server` config that trusts this space's operator and serves its
 *  accounts via the in-config MEMORY resolver. */
export function serverConfig(
  auth: SpaceAuth,
  opts: {
    port?: number;
    host?: string;
    storeDir: string;
    /** Additional operator-signed accounts to preload in the MEMORY resolver — e.g. the dedicated
     *  auth-callout account (`@cotal-ai/auth`), which must never share the data account. */
    extraAccounts?: Array<{ pub: string; jwt: string }>;
  },
): string {
  const port = opts.port ?? 4222;
  const host = opts.host ?? "127.0.0.1";
  // A minted "agent" carries its full permission allow-list inline in its user JWT, which the
  // client sends in the CONNECT protocol line. With per-channel + JetStream-API grants that JWT
  // exceeds the 4 KB default max_control_line at ~2 channels, and the server then silently drops
  // the connection (the client retries forever — a connect that "hangs"). Raise it to fit a rich
  // agent JWT — but right-sized, not generous: the CONNECT line is parsed BEFORE auth, so the cap
  // is a per-connection pre-auth allocation under connection flooding. 64 KB clears a many-channel
  // agent JWT (~4–8 KB) with wide margin while keeping the pre-auth surface ~16× tighter than 1 MB.
  return `# Generated by \`cotal up\` - do not edit by hand.
host: ${host}
port: ${port}
max_control_line: 65536
jetstream { store_dir: ${JSON.stringify(opts.storeDir)} }
operator: ${auth.operator.jwt}
system_account: ${auth.sys.pub}
resolver: MEMORY
resolver_preload: {
  ${auth.account.pub}: ${auth.account.jwt}
  ${auth.sys.pub}: ${auth.sys.jwt}${(opts.extraAccounts ?? []).map((a) => `\n  ${a.pub}: ${a.jwt}`).join("")}
}
`;
}
