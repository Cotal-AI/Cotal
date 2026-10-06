# Platform-owned pooled control authority

Status: the door shipped in `@cotal-ai/core` and `@cotal-ai/auth` 0.60.0, and its readiness read in
0.62.0. The platform's own Runtime and composition root are not part of Cotal. Section 9 lists
what landed and what did not. The source inventory in section 1 was checked at
`06f48f40473f809bcb31f2ba21b3ceb1d33ccc18` (v0.58.0), before the door existed.

The question is how a platform runs one administrative control manager per account in `pooled`
mode without holding any human's login session. The answer reuses everything the human remote
supervision path already proves (the closed request family, the five identities, the registration
proof, the process epoch and the all-duty renewal). It changes only who is authenticated and who
the holder is.

## 1. What the published contract did at v0.58.0

A private probe against the built packages at the head above showed the following. The probe is
not a committed test.

| Cell | Input | Observed |
|---|---|---|
| F1 | `new Manager({ pooled: true, runtime: "tmux" })` with no `remoteAuthority` | `pooled control requires signerless remote authority and an explicit non-PTY runtime; local custodial execution is forbidden` |
| F2 | a platform-assembled `remoteAuthority` (five fresh nkeys, account-signed JWTs) with no `renewStandingBundle` | `pooled control requires a closed host-issued all-duty renewal callback before construction` |
| F3 | the same with a renewal stub and no `accountPublicKey` | `pooled control requires a proved assigned account for its initial supervisor credential` |
| F4 | the same with the account key the platform signed with | passes every pooled authority check and fails later at runtime resolution |
| F5 | `remoteManagerClient.remoteStandingBundleRenewal(...)` with a capturing `call` | emits `kind: "manager-service-authority"`, `operation: "renewStandingBundle"`, `actor: "cli"` |
| F6 | members of the published `AuthProvider` that return `RemoteManagerAuthorityMaterial` | only `managerServiceAuthority` |
| PC | stock `cotal supervise` on a registered remote user mesh | no login: refused with `not logged in ... run cotal login --idp`. With a seeded login session and a loopback recorder: one POST to `/manager-service-authority` carrying `idpToken` and a `prepare` request |

The constructor's pooled checks are coherence checks (F4): they prove the material is shaped like
host-issued material for one account, not that a host issued it. The authority boundary is the
host's issuance door and the broker. At v0.58.0 the only such door was the human one, which
authenticates an IdP subject, derives a `u_…` owner from it and requires `supervise` on that human's
ledger row. A platform that wanted this mode had two options. It could hold a human's session, or
it could sign material itself and skip the gate, ledger and proof protocol that make the material
revocable. Both are refused here.

## 2. Scope

In scope: one new optional door on the hosted authority handle, its request and result types, the
host-side assignment observation it authorizes against, the holder principal, the transition into
an existing deployment, the lifetime input the renewal proof needs, the refusals, and the hand
acceptance a host must pass. SPEC §13.1, §13.6 and §13.9 gain clauses, and Appendix B gains a
profile bullet.

Out of scope: any change to the human `manager-service` view, a generic host profile, a hosted
launcher or Runtime, a new daemon or listener, cross-owner control of human agents, moving an
existing agent to the platform owner, release.

The `p_` holder starts and renews only its own administrative control manager and its same-owner
descendants; an agent owned by a `u_` user is provisioned and retired only on the existing
user-bound path, a human's `supervise`-scoped manager with `enrollManagedAgent`.

## 3. The composition

| Piece | Human path | Platform service view |
|---|---|---|
| Door | `AuthProvider.managerServiceAuthority` and its sibling remote-manager methods, which POST to `/manager-service-authority` | `AuthServiceHandle.platformControlAuthority` (one in-process method, new); no route |
| Who is authenticated | a human, by IdP token, on the loopback or public face | nobody: the caller is the trusted composition that started the authority context; no IdP token, no capability |
| What authorizes | the human's ledger row holds `supervise` | the host's current platform-control assignment (new, backend-written) |
| Holder owner | `u_…`, derived from the IdP subject | `p_…`, derived from the assigned account (new grammar) |
| Actors | `remoteManagerActors(instanceId)` | unchanged |
| Request and result types | `RemoteManagerAuthorityRequest` and siblings | unchanged, carried inside a closed envelope |
| Registration proof | `remoteManagerRegistrationProof`, `remoteManagerCurrentRegistrationProof` | unchanged, keyed by the `p_` owner |
| Process epoch fence | `authorizeRemoteManagerRenewal` | unchanged |
| All-duty renewal | `remoteStandingBundleRenewal` | unchanged, with `call` bound to the new door |
| `ManagerOptions.remoteAuthority` | built by `cotal supervise` | unchanged shape, built by the platform's composition root |
| Runtime | stock PTY or explicit | `pooled: true` with the platform's own non-custodial Runtime |

### 3.1 The door

The door is a typed method on the handle `startAuthService` returns. It is not an `AuthProvider`
method and not an HTTP route. Three facts about the shipped hosted path decide this:

- Issuance needs the running authority context: its issuer connection for the gate CAS and the
  `epcred` rows, and the issuer closures the human route reaches through its handler context.
  `AuthProvider` methods take `{ store, dir }` and run in the caller's process. The provider's
  authority methods are clients that start from this machine's human login and POST to a listener.
- `startAuthService` writes no discovery file. Only `runAuthService` writes `auth-service.json`
  with the capability. `AuthServiceHandle` carries the capability for the host's own loopback host
  actions, and the door never uses or returns it.
- The loopback capability alone authorizes the interactive and managed lifecycle-retirement doors.
  Exposing it on the hosted inputs or handle so a control worker can call a route would give that
  worker authority beyond its assignment.

Two shapes can let the trusted authority side run the closed issuer operations for the service
view without handing the control worker the capability or the account signer. Both were weighed:

| | A. Typed in-process method on the hosted handle | B. Protected capability option on the hosted inputs |
|---|---|---|
| What the host adds | `platformControl` on the `startAuthService` inputs and one optional method on `AuthServiceHandle` | a host-supplied capability on `HostedContextInputs`, plus a route on the loopback listener that checks it |
| New protocol | none; a typed call inside the authority process | a route and request body on a listener |
| Secret handed out | none | the capability, to every caller that must reach the route |
| What the caller can do | only the closed request it makes, for its own assignment | whatever the capability authorizes. Today's loopback capability also authorizes the lifecycle-retirement doors, so a platform-only capability would be a second standing secret for the account |
| Control worker in another process | the platform's own peer-uid-checked channel carries the envelope to the authority process | the route is the channel, and the capability lives in the control worker |

Option B does not avoid a new protocol. The capability only authenticates; the closed operations
still need a route, and the route is the new protocol. It also puts a standing secret in the
control worker that authorizes more than its own assignment. Option A adds neither. So the method
is the chosen shape, `AuthProvider` gains no method, and no new protocol is added. A platform that runs
the control manager in another process or uid carries the closed envelope to the authority process
over its own caller-bound channel. That channel is the platform's peer-uid-checked adapter from the
hosted runtime contract. The authority process calls the method in-process. The control worker
never holds the capability or the account signer.

Declarations as they landed in `@cotal-ai/core`. The request types are in
`packages/core/src/remote-manager-authority.ts` and the owner grammar is in
`packages/core/src/subjects.ts`.

```ts
/** The closed set of typed manager requests the service door carries. Each inner request keeps its
 * existing parser, fields and result. The envelope adds only the assignment the call rides on. */
export type PlatformControlInnerRequest =
  | RemoteManagerAuthorityRequest
  | RemoteManagerMaintenanceRequest
  | RemoteRetainedAgentValidationRequest
  | RemoteManagerGoalIndexScanRequest
  | RemoteManagerAdminAuthorizationRequest
  | RemoteRunAdmissionRequest
  | RemoteRunAttemptRequest;

/** Closed envelope for one service-door call. It names no profile, permission, subject, TTL, claim
 * or IdP token. The host derives the owner and every grant; nothing here is an identity assertion.
 * The inner request keeps its own operation-specific coordinates (section 3.2, step 4). */
export interface PlatformControlAuthorityRequest<R extends PlatformControlInnerRequest = PlatformControlInnerRequest> {
  v: 1;
  kind: "platform-control-authority";
  space: string;
  /** The assigned data account. It must equal the serving authority context's account and the
   * assignment's account, and on a renewal the inner request's `accountPublicKey`. */
  accountPublicKey: string;
  /** The assignment revision this control process was started under. Any other value is refused. */
  assignmentRevision: number;
  request: R;
}

export type PlatformControlAuthorityResult<R extends PlatformControlInnerRequest> =
  R extends RemoteManagerAuthorityRequest ? RemoteManagerAuthorityMaterial
  : R extends RemoteManagerMaintenanceRequest ? RemoteManagerMaintenanceResult
  : R extends RemoteRetainedAgentValidationRequest ? RemoteRetainedAgentValidationResult
  : R extends RemoteManagerGoalIndexScanRequest ? RemoteManagerGoalIndexScanResult
  : R extends RemoteManagerAdminAuthorizationRequest ? RemoteManagerAdminAuthorizationResult
  : R extends RemoteRunAdmissionRequest ? RemoteRunAdmissionResult
  : R extends RemoteRunAttemptRequest ? RemoteRunAttemptResult
  : never;

/** Format of a platform owner token: `p_` + 26 lowercase base32. Disjoint from `u_…` derived
 * owners, from the `local` dev owner and from nkeys. */
export const PLATFORM_OWNER_PREFIX = "p_";
export function assertPlatformOwnerToken(owner: string): string;
/** Opt-in at a trust boundary; absent, a `p_` owner is refused as before. */
export function assertPrincipalOwnerToken(owner: string, opts?: { allowLocal?: boolean; allowPlatform?: boolean }): string;
export function isPrincipalOwnerToken(owner: string, opts?: { allowLocal?: boolean; allowPlatform?: boolean }): boolean;
/** Opt-in in the eviction and liveness sweeps only (section 6); the membership feed stays default. */
export function principalFromConnz(conn: { tags?: readonly string[]; authorized_user?: string }, opts?: { allowPlatform?: boolean }): string | null;
```

The managed-agent kinds (`manager-managed-agent-enrollment`, `-prepare-retirement`,
`-runtime-create`, `-runtime-status`) are not in the union. The human route already refuses them
`unimplemented` because they mutate platform-owned storage. A platform that owns those writers
decides them on its own route against the same assignment.

### 3.2 The host side

Declarations as they landed. `PlatformControlAssignment` is in `@cotal-ai/core` beside the request
types, and `@cotal-ai/auth` re-exports it. The rest is in `@cotal-ai/auth`.

```ts
/** One platform-run control manager assigned to one account. The platform backend is its only
 * writer, and an account has at most one current row. The authority context reads it fresh for
 * every service-door call and never caches it. */
export interface PlatformControlAssignment {
  v: 1;
  space: string;
  accountPublicKey: string;
  /** The platform's protected, stable control instance id. Reused across every restart. */
  instanceId: string;
  /** The control instance's manager lifecycle UID. Reused across every restart. */
  lifecycleUid: string;
  /** The manager instance this control instance replaces, from the backend's protected mapping.
   * The door only reads its registration and gate; it never writes them (section 7). */
  predecessorInstanceId?: string;
  assignmentRevision: number;
  state: "assigned" | "revoked";
}

export interface PlatformControlInput {
  /** The one current assignment for this account, or null. Read fresh on every door call. */
  observeAssignment(space: string, accountPublicKey: string): Promise<PlatformControlAssignment | null>;
}

export function startAuthService(inputs: HostedContextInputs & {
  port?: number;
  publicFace?: PublicFaceInput;
  /** Present only in a platform composition. Absent: the handle has no service door. */
  platformControl?: PlatformControlInput;
  /** Trusted-host only. Forwarded unchanged to `openAuthAuthorityPlane`, which bounds it to
   * 5..86400 as today. Absent: the 24h default. No CLI flag and no request field sets it. */
  standingRenewableTtlSeconds?: number;
}): Promise<AuthServiceHandle>;

export interface AuthServiceHandle extends HostedServiceHandle {
  readonly url: string;
  readonly publicUrl?: string;
  /** The per-start loopback capability. It stays in the authority process. */
  readonly cap: string;
  /** The platform control door. Present only when `platformControl` was supplied. In-process and
   * typed: no route, no capability, no signer or capability in the result. */
  platformControlAuthority?<R extends PlatformControlInnerRequest>(
    request: PlatformControlAuthorityRequest<R>,
  ): Promise<PlatformControlAuthorityResult<R>>;
}

/** `p_` + the first 26 base32 chars of
 *  HMAC-SHA256(ownerSecret, "cotal/platform-control-owner/v1\0" + space + "\0" + accountPublicKey). */
export function platformControlOwner(ownerSecret: string | Uint8Array, space: string, accountPublicKey: string): string;
```

`runAuthService` (the CLI daemon) never constructs the door. No listener, loopback or public,
serves it. One call runs in this order, and every refusal writes nothing:

1. The envelope is closed. An unknown field, including `idpToken`, is `bad-request`. The inner
   `session` object must have exactly `id`, `endpoint`, `sessionId`, `epoch` and `exp`. The reused
   manager-service parser checks those members but not the key set, so the door checks it, and the
   human route's parser is unchanged. `space` and `accountPublicKey` must equal the context's own
   `HostedContextInputs`, so one context never issues for another account.
2. `observeAssignment(space, accountPublicKey)` is read fresh. It must exist and be `assigned`. Its
   account and revision must equal the envelope's, and its `instanceId` and `lifecycleUid` must
   equal the inner request's `instanceId` and `managerLifecycleUid`. A null or `revoked` row, or an
   instance the row does not name, is `permission-denied`. An observer error is `unavailable`,
   never a cached answer. One row per account means one control instance per account. When the
   assigned instance already has an issuance gate, its principal must be
   `<p_owner>.manager_serve_<instanceId>`; a gate naming any other principal is `permission-denied`.
   For `prepare` and `activate` only, when the row names a `predecessorInstanceId`, the host reads
   that instance's `svc.manager` registration and its `epgate.manager` row. A current registration
   or a `frozen` gate is `failed-precondition`, and the host does not probe, freeze, evict, revoke
   or deregister it (section 7).
3. `owner = platformControlOwner(...)`. The owner is never read from the request.
4. The inner request goes through its existing closed parser. Its `actor` field must be the literal
   `"cli"`. That literal is the shipped request builders' envelope constant. The service door never
   reads it as a ledger key, and it names no principal. The inner request keeps its existing
   operation-specific coordinates, and the host validates them as the human route does: the
   `session` operation's requested `exp` is capped at the host's 24h bound
   (`implementations/auth/src/service.ts`, the `session` branch), and the run admission's
   `run.subject` is re-parsed and checked against the caller's issued ceiling (`admitRemoteRun`).
   Neither selects a signing subject, permission set or a lifetime past the host's bound.
5. The call dispatches to the same functions the human route uses (`issueRemoteManagerAuthority`,
   `authorizeRemoteManagerRenewal`, maintenance, retained validation, goal-index scan, admin
   authorization, run admission and attempt). Their authorization input is the closed union
   `ManagerAuthorityHolder = { holder?: "human"; owner; scope } | { holder: "platform"; owner;
   assignment }`. The human arm's tag is optional so every existing caller keeps its shape and its
   refusal sentence. The platform arm replaces the `supervise` check with the assignment check
   (`requireManagerAuthorityHolder`). It never passes a synthesized `["supervise"]` scope.
6. Maintenance needs one more service-only guard. In the platform arm, `targetInstanceId` must
   equal the assignment's `instanceId` for both `evict-family-principal` and
   `reconcile-registration`, and the observed target gate's principal must equal
   `<p_owner>.manager_serve_<instanceId>`. Both checks run before any liveness probe, revocation,
   eviction or reopen, and a failure is `permission-denied` with no effect. The shared
   `authorizeRemoteManagerMaintenance` checks gate ownership only for eviction, because the human
   path may reconcile a foreign slot holder in the same space. Reusing it with only the scope check
   replaced would let the service view probe, revoke, evict and reopen a frozen gate a human owns.
   The human arm keeps that foreign-slot repair unchanged. A foreign slot holder blocks platform
   registration with the existing registration refusal, and the platform's composition passes no
   `reconcileForeignRegistration` callback. The holder is repaired by its own owner through
   `manager-service` maintenance, or by the host operator with `cotal reconcile-gate`.

### 3.3 What `ManagerOptions.remoteAuthority` needs

Nothing new. `pooled: true` already requires signerless remote authority, an explicit non-PTY and
non-custodial runtime, `renewStandingBundle` and an `accountPublicKey` proved against the initial
supervisor credential. The service door supplies all of them:

| Field | Platform source |
|---|---|
| `owner` | `material.owner` from `prepare` (a `p_…` token) |
| `actors`, `instanceId`, `lifecycleUid` | the assignment, echoed and checked against `material` |
| `identities` | five nkeys the control context generates; seeds never leave it |
| `supervisorCreds`, `executorCreds` | `prepare`, via `materialCredential` |
| `serveCreds`, `goalWriterCreds`, `sessionLedgerCreds` | `activate` |
| `renewStandingBundle`, `accountPublicKey` | `remoteStandingBundleRenewal({ ..., call })`, with `call` wrapping the door |
| `renewExecutor`, `mintSessionServing`, `mintRetirementRequester` | inner `renew`, `session`, `retire` through the door |
| `validateRetainedAgent`, `scanGoalIndex`, `authorizeAdmin`, `runHosting` | the sibling inner kinds through the door |
| `prepareAgentRetirement`, `enrollManagedAgent` | the platform's own route (section 3.1) |
| `serveGrant` | `registerRemoteManagerAuthority`, unchanged |

A `holder` field on `ManagerOptions` was considered and rejected. The Manager cannot verify where its
material came from (F4), so the field would be advisory and enforce nothing. The platform's library
composition root mirrors the remote branch of `runManager` in
`implementations/manager/src/commands.ts`, with each provider call replaced by a call to the door,
in-process or over the platform's own caller-bound channel. The one
other difference is identity state: the platform builds `RemoteManagerIdentityState` from the
assignment's `instanceId` and `lifecycleUid`. It never calls `loadOrCreateRemoteManagerIdentity`,
which mints both locally. Stock `cotal supervise` is unchanged and gains no flag.

## 4. How the five identities are bound

| Identity | Actor | Principal | Bound to |
|---|---|---|---|
| supervisor | `manager_<instanceId>` | `p_….manager_<instanceId>` | owner, instance, lifecycle, account, nkey |
| executor | `manager_exec_<instanceId>` | `p_….manager_exec_<instanceId>` | same |
| serve | `manager_serve_<instanceId>` | `p_….manager_serve_<instanceId>` (the gate principal) | same, plus the gate's process epoch |
| goal writer | `manager_goal_<instanceId>` | `p_….manager_goal_<instanceId>` | same |
| session ledger | `manager_session_<instanceId>` | `p_….manager_session_<instanceId>` | same |

- The account comes from the assignment. It must equal the authority context's account, and the
  issued JWTs name it in `nats.issuer_account`. The Manager re-checks it on every renewal.
- The instance id and lifecycle UID come from the assignment. A request carrying any other value is
  refused before parsing reaches issuance. The platform keeps both in its protected store and
  reuses them on every restart, so a restart is the same instance at a later process epoch, never
  a second instance. A retired lifecycle is never revived (§13.1). A new incarnation needs a new
  lifecycle UID from the backend.
- The owner is derived from the space and account, so it is stable across instance replacement and
  changes when a same-slug account is recreated.
- The nkeys are caller-held. The registration proof binds them, and the host checks `sub` against
  them on every issuance.

## 5. Renewal and fencing reused unchanged

- `remoteStandingBundleRenewal` is called unchanged. Its `call` wraps each inner request in the
  envelope. Its echo validation (`remoteManagerRenewalCredentials`) is unchanged: same owner, same
  identities, same account, same process epoch, all five credentials or none.
- The registration proof is unchanged. `remoteManagerRegistrationProof(owner, request)` and the
  host-keyed `remoteManagerCurrentRegistrationProof(secret, owner, request, gate)` both bind the
  owner. Because `p_` and `u_` owners are disjoint, a proof from one door never validates on the
  other.
- The process epoch fence is unchanged. `authorizeRemoteManagerRenewal` requires an open gate, a
  gate principal equal to `<p_owner>.manager_serve_<instanceId>`, a gate `processEpoch` equal to the
  request's, and a timing-safe proof match. The assignment check runs first.
- Manager-side adoption is unchanged. `renewRemoteStandingBundleOnce` preflights all five
  credentials on real connections, refuses if the serve epoch moved, keeps last-good on any
  failure and records cleanup debt.
- Revocation: when the backend marks the assignment `revoked` or advances its revision, the next
  door call is refused, renewal included. Live connections end at their JWT expiry. An immediate
  cut uses the host's existing verified revocation (freeze the gate, revoke the family,
  verified-evict), the same as the human path. A later start needs a fresh `prepare` and
  `activate` under a current assignment.
- Renewal never re-authenticates a person, because the door has no person in it.

The renewal proof runs on the real paths with no fake clock. Two cadences matter, both read from
source at the head above:

- The all-duty bundle. `renewRemoteStandingBundleOnce` renews when any of the five held
  credentials is past its renewal point (75% of its iat-to-exp lifetime). The executor in every
  `prepare` and `renewStandingBundle` result has a fixed five-minute lifetime, and the timer ticks
  every `min(credRenewIntervalMs(300), credRenewIntervalMs(ttl))`, which is 75 seconds for any TTL
  of five minutes or more. So with the default 24h TTL the five-credential renewal already runs
  about every four to five minutes.
- Everything that moves only on the standing TTL. The run-driver and run-mediator pair renew past
  their own renewal point (`RunHosting.renew`), and the expiry half of revocation (H9) waits for a
  credential to reach `exp`. With the 24h default each of these takes 18 to 24 hours of wall clock
  per attempt.

`openAuthAuthorityPlane` already accepts `standingRenewableTtlSeconds` (bounded 5..86400,
trusted-host only), and the remote manager derives its timer from the issued credential's
`exp - iat`. At v0.58.0 no shipped composition passed it. The choice for the renewal proof is the
one-field pass-through on the `startAuthService` inputs (section 3.2) over the full 24h wall clock,
and it landed with the door: `startAuthService` forwards the value to the plane unchanged.
`runAuthService` and the CLI still have no flag for it. It changes only the lifetime the host signs,
the host sets it, and the plane's existing bound applies. With a 300-second TTL every standing credential, the run-driver pair included, passes its
renewal point about 225 seconds after issue and renews on the next 75-second tick, on the same
code a 24h host runs. A host that does not set it can still pass H7 by waiting out the 24h clock.
A constructor test is not a renewal proof.

## 6. The holder principal

The holder is a platform principal: owner `p_…`, actors fixed by the instance id. It is never a
`u_…` owner, never derived from an IdP subject and never the `local` dev owner. The `p_` grammar is
disjoint from `u_` by prefix and from nkeys by case, length and `_`. Keying the HMAC with the
space's owner secret keeps the token opaque per space, the same as derived owners.

Every trust-boundary owner check (`assertPrincipalOwnerToken`, `isPrincipalOwnerToken`, CONNZ
attribution, the descendant request parsers) still accepts only `u_…` or `local` by default. The
two principal checks and `principalFromConnz` gain an `allowPlatform` option. These boundaries opt
in, each on the platform family or its same-owner descendants:

| Boundary | Why it must see a `p_` owner |
|---|---|
| issuance gate row parser, credential-ledger holder principal | the gate and every `epcred` row name the platform serve principal |
| CONNZ attribution in the eviction and liveness sweeps, and the delivery daemon's `evictPrincipal(s)` and `principalLiveness` executors | registration restart, gate repair and verified revocation must find the platform family's live connections; without it a still-live `p_` connection is dropped from the sweep and reads as gone |
| the manager goal-index scanner | boot reconcile scans `goalidx.manager.<p_owner>.>` for the restarted instance's predecessor goals |
| `runDriverCaller` and the run driver grants | a platform manager's hosted run is driven under `<p_owner>.wf_…` |
| the retirement target, retained-validation target and admin caller parsers, for the platform holder only | the door answers these for its own `p_` descendants; the human route's parsers are unchanged |

A `u_` target or caller still parses on the platform arm and is then refused on owner mismatch, so
the door never acts on another owner (R8). The auth ledger holds rows only for derived owners, so a
platform-owned agent's retained validation is the same "unknown agent" denial as any absent row, and
its admin authorization is `authorized: false`. Every other owner check refuses a `p_` owner as
before, including the membership feed and the message drop guards, and `assertDerivedOwnerToken`
never accepts one. Presence has no owner check to opt in: the roster reader drops only a record
whose `card.id` differs from its KV key, and the write side is scoped to the publisher's own key.
A platform supervisor endpoint built like the remote Manager's therefore already registers and sees
its own roster card under the `p_` owner. No test was committed for the negative
side. The hand test checks that the default guard and the derived-owner check refuse the issued
`p_` owner. SPEC §13.1 scopes this extension of the §2 owner format to these principals; §2 itself
is unchanged. The §13.2 mode-word discrimination still holds, because a `p_` token contains `_` and
no mode word does.

Admin authorization on a platform manager answers `authorized: true` only for a caller whose owner
equals the service owner. This change issues no `p_` principal outside the manager's own family, so
in practice no external caller is authorized for owner-domain admin. A human `admin` scope never
reaches a platform manager. Human operator access to a platform manager would be a separate delta.

## 7. Entering an existing deployment

The production target is existing stock 0.55 deployments on Node 22 (broker, authority context and
manager) that keep their account keys, issuer, agents and sessions. The service view enters one
through a fenced transition.

- **Authority side.** The deployment's authority context is upgraded in place to a release that
  carries the door. The account key and issuer stay the deployment's own, and the door issues only
  for that context's account (section 3.2, step 1). A 0.55 authority context has no door, so the
  platform's control manager fails closed at its first door call. It never falls back to the human
  door or to material it signs itself.
- **Stable instance id and lifecycle UID.** The platform keeps one protected record per account:
  the control instance id (a lifecycle token) and its manager lifecycle UID. The backend writes both
  into the account's one assignment. The control worker reads them from the assignment and never
  chooses or mints them. Every restart reuses both, and a restart is the existing same-principal
  re-registration: the barrier freezes `epgate.manager.<instanceId>`, verify-evicts the superseded
  family and advances `processEpoch`. The predecessor process's renewal at the old epoch is
  `conflict` (H8).
- **The legacy manager's registration stays its own.** At the head above, a stock local manager
  registers `svc.manager.<legacyInstanceId>` under the `local` owner, with its persisted serve nkey
  as the gate principal's actor. A human remote manager registers under its `u_` owner. Core
  refuses a re-registration that changes an instance's owner (`registerServiceInstance`: "a
  re-registration can never change ownership"), a gate's principal is fixed when the gate is
  provisioned, and a gate is never deleted. So the platform principal never binds to the legacy instance's registration,
  gate or lifecycle. An assignment that names the legacy instance id as its own `instanceId` is
  refused at the gate principal check (R2).
- **Closed predecessor first.** The backend's protected mapping names the legacy instance as the
  assignment's `predecessorInstanceId`. `prepare` and `activate` proceed only when that instance has
  no current `svc.manager` registration and its gate is not `frozen` (section 3.2, step 2). A stock
  manager's clean stop deregisters its record, so the order is: the legacy manager stops through its
  own path, then the control instance prepares and activates. A legacy manager that crashed keeps
  its record and blocks the transition until its own operator path removes it. The door only reads
  the predecessor. The platform composition passes no `reconcileForeignRegistration` callback, and
  the door's maintenance cannot target another instance (step 6). So the platform never evicts,
  freezes, reopens or deregisters a legacy manager, and never force-takes a live one.
- **Agents and sessions.** Agents keep their own lifecycle credentials and their owner. The service
  view provisions, retires and administers only agents whose owner is its `p_` token (R8). An agent
  owned by `local` or a `u_` owner keeps running on its own authority, under its own owner. Moving
  it under the platform owner would be a separate owner-transfer delta. Endpoint sessions the
  legacy manager served end with its serving epoch (§13.6) and are established again against the
  control instance.
- **Runtime.** The platform embedding supplies its own non-custodial `Runtime` that implements
  core's contract and constructs the Manager with `pooled: true`. This design adds no hosted
  launcher, Runtime or daemon upstream (R3, R5).

## 8. Refusals

Each refusal maps to the SPEC clause that states it. A security reviewer can check the pair.

| # | Refusal | Mechanism | Clause |
|---|---|---|---|
| R1 | No human impersonation | the closed envelope has no IdP field and refuses one; the owner is derived from the assignment in the `p_` grammar; issuance never reads or synthesizes `supervise`; proofs and gate principals are owner-bound, so neither door accepts the other's material | §13.1 Platform control authority, first and third paragraphs; §13.6 Platform control registration |
| R2 | No takeover of another owner's instance | the service door refuses an instance whose gate principal names any other owner, including a human-owned instance; maintenance `targetInstanceId` must be the assigned instance and its gate principal the platform serve principal before any effect (section 3.2, step 6); no force path; that instance retires through its own owner's path first | §13.1 Platform control authority, third paragraph; §13.6 Platform control registration, maintenance paragraph |
| R3 | No local or custodial runtime | the composition must construct `pooled: true`, and the existing constructor checks refuse PTY, `auto` and custodial runtimes; the host issues no signer, provisioner or launch authority, so the family cannot run local custody on the host's behalf; the platform supplies its own non-custodial Runtime and this design adds no hosted launcher or Runtime upstream | §13.1 fourth paragraph; Appendix B `platform-control` |
| R4 | No generic signing RPC | a closed union of seven existing kinds; the envelope has no profile, permission, subject, TTL or claim input; inner requests keep only their existing operation-specific coordinates, validated as on the human route (session `exp` capped at the host bound, run admission `run.subject` checked against the caller's issued ceiling); unknown fields `bad-request`, including a nested `session` field; managed-agent kinds `unimplemented` | §13.6 Platform control registration |
| R5 | No new daemon, listener or protocol | one in-process method on the hosted authority handle, present only when the host supplies `platformControl`; never constructed by `runAuthService`; no route on any listener; the loopback capability is never handed out; the platform supplies its own Runtime and its own caller-bound channel | §13.6 Platform control registration |
| R6 | Not an exchange view | `platform-control` is never a `view` on `/exchange`; the public and managed-agent exchanges refuse it as an unknown view | §13.1 Platform control authority, first paragraph |
| R7 | No assignment, no authority | absent observer: no door on the handle. Null, revoked or stale assignment, or an instance id or lifecycle UID the account's one assignment does not name: `permission-denied`. Observer failure: `unavailable` | §13.1 second paragraph; §13.6 |
| R8 | Same-owner descendants only | enrollment, retirement, retained validation and admin authorization all bind to the `p_` owner; a human-owned agent is never provisioned, retired or administered through this view | §13.9 Platform control grant |
| R9 | Human view unchanged | every existing human remote-supervision clause is byte-identical; the SPEC diff for this change is insertion-only | §13.1, §13.6, §13.9 (existing text) |
| R10 | No force-take of a live legacy manager | `prepare` and `activate` refuse `failed-precondition` while the assignment's `predecessorInstanceId` has a current `svc.manager` registration or a `frozen` gate; the door only reads the predecessor and never probes, freezes, evicts, revokes or deregisters it; no `reconcileForeignRegistration` callback; maintenance confined to the assigned instance (section 3.2, steps 2 and 6; section 7) | §13.1 Platform control authority, second and third paragraphs |
| R11 | No rebinding of an existing instance to the platform owner, and no invented `u_` owner | core refuses a re-registration that changes an instance's owner; a gate's principal is fixed at provisioning and a gate is never deleted; the door refuses an instance whose gate names another principal; the platform's own instance id and lifecycle UID stay stable across restarts, which re-register at a later process epoch; the owner is always the derived `p_` token (section 7) | §13.1 Platform control authority, second and third paragraphs |

## 9. What landed

| Symbol | Package | Status |
|---|---|---|
| `PlatformControlInnerRequest`, `PlatformControlAuthorityRequest`, `PlatformControlAuthorityResult`, `PlatformControlAssignment` | `@cotal-ai/core` | landed, insertion-only; existing request types unchanged |
| `PLATFORM_OWNER_PREFIX`, `assertPlatformOwnerToken`, the `allowPlatform` option on the owner checks and `principalFromConnz` | `@cotal-ai/core` | landed; opted in only at the boundaries section 6 lists |
| the `allowPlatform` opt-in at the eviction and liveness executors | `@cotal-ai/delivery` | landed |
| `platformControlOwner`, `PlatformControlInput`, `parsePlatformControlAuthorityRequest`, `ManagerAuthorityHolder` | `@cotal-ai/auth` | landed |
| `startAuthService` input `platformControl`, `AuthServiceHandle.platformControlAuthority` | `@cotal-ai/auth` | landed; the member exists only when the input is supplied |
| `AuthServiceHandle.platformControlReadiness` | `@cotal-ai/auth` | landed with the same input; reads the assigned instance's `status` over the context's own connection, pinned to that instance's `describe` and `status` |
| the read-only predecessor check and the assigned-instance gate check (section 3.2, step 2) | `@cotal-ai/auth` | landed |
| `startAuthService` input `standingRenewableTtlSeconds` | `@cotal-ai/auth` | landed as a pass-through; the plane's 5..86400 bound applies |
| the `holder` authorization union and the maintenance guard (section 3.2, steps 5 and 6) | `@cotal-ai/auth` | landed |
| `remoteStandingBundleRenewal`, both registration proofs, `authorizeRemoteManagerRenewal`, `ManagerOptions.pooled` | core, auth, manager | shipped, reused unchanged |

`runAuthService` and the CLI construct no door. No listener, route, daemon or capability was added.
The door needs no change in `@cotal-ai/manager`: a platform composition builds
`ManagerOptions.remoteAuthority` with the shipped `remoteManagerClient` builders and the door as
their `call` (section 3.3).

Not in this change: the platform's own Runtime and composition root, and the managed-agent kinds,
which the platform decides on its own route. Acceptance rows H6 to H9, H12 and H15 to H18 need one
of those, a legacy deployment or the wall clock.

## 10. Native acceptance

These are hand tests an operator runs against a real broker, a hosted authority context started
with `startAuthService` and `platformControl`, and the platform's own composition and Runtime. They
are not smoke suites. Each states the input and the observable result. A host passes when every
row matches.

| # | Do | Expect |
|---|---|---|
| H1 | Start the context without `platformControl` | `handle.platformControlAuthority` is `undefined` |
| H2 | With `platformControl`: POST any `/platform-control*` path to the loopback and public listeners, with and without the capability | 404 on both; no gate or ledger write (auth KV revisions unchanged) |
| H3 | Call the door with an envelope that also carries `idpToken` | `bad-request`; no material |
| H4 | Call the door with no assignment, a `revoked` one, a stale `assignmentRevision`, another account, another `lifecycleUid`, and an `instanceId` the account's assignment does not name | `permission-denied` for each; no write |
| H5 | `prepare` then `activate` on a fresh assignment | `material.owner` matches `^p_[a-z2-7]{26}$`; `material.actors` equals `remoteManagerActors(instanceId)`; every JWT names the assigned account in `nats.issuer_account` and a caller-held nkey in `sub`; the `epgate.manager.<instanceId>` principal is `<p_owner>.manager_serve_<instanceId>` |
| H6 | Construct the platform Manager with `pooled: true` and `runtime: "pty"`, then with the platform Runtime | first refused with the pooled PTY sentence; second starts, and its roster card owner is the `p_` token |
| H7 | Start the context with `standingRenewableTtlSeconds: 300` (section 5), start the platform manager, admit one hosted run, and leave both running for 15 minutes with no clock change. A host without the pass-through runs the same row at the 24h default for 25 hours | at least two all-duty renewals in the manager log, each replacing all five credentials with new `iat` and `exp`, the same nkeys, the same account and an unchanged process epoch; the run-driver and run-mediator credentials replaced past their renewal point; no all-duty renewal refusal |
| H8 | Restart the platform manager, then replay the predecessor's `renewStandingBundle` with the old `processEpoch` | the restarted manager keeps the assignment's instance id and lifecycle UID, and its gate's `processEpoch` is one higher; the replay is `conflict` (stale epoch); no JWT returned |
| H9 | Backend marks the assignment `revoked` | the next renewal is `permission-denied`; the manager keeps last-good and logs debt; after expiry the broker refuses its connections; restart needs a new assignment |
| H10 | Present a human `manager-service` registration proof to the door for that instance, a service-view request on `/manager-service-authority` with a human IdP token, and a door call for an instance whose gate principal is a `u_` owner | all refused; the human instance's gate is unchanged |
| H11 | Send an inner request with an extra field (`profile`, `permissions`, `ttl`), a `session` request with an extra field inside `session`, a managed-agent enrollment kind, and an unknown kind. Then send a `session` request whose `exp` is 48h ahead | `bad-request`, `bad-request`, `unimplemented`, `bad-request`; the session-serving JWT's `exp` is at most 24h after issue |
| H12 | On the same host, a signed-in human with `supervise` runs `cotal supervise`; then without `supervise` | the first works as before; the second gets the existing refusal sentence |
| H13 | A `u_` principal asks the platform manager to spawn, and asks `authorizeAdmin` | spawn refused on owner mismatch; `authorized: false` |
| H14 | Check the host for new listeners and daemons, and the control worker for the capability and signer | no new listening socket in `ss -ltnp`; the control worker's environment, files and store hold neither the loopback capability nor the account signing seed |
| H15 | Freeze a human `manager-service` registration on instance B in the same space (stop it mid-registration). Then call the door with a `reconcile-registration` maintenance request whose `targetInstanceId` is B, and with an `evict-family-principal` request that targets B. Then run the same reconciliation as B's human owner through `manager-service` | the two door calls are `permission-denied` before any probe; B's gate revision, its `epcred` family and its holders are unchanged (auth KV revisions unchanged); the human owner's reconciliation runs as before |
| H16 | On a deployment running a stock legacy manager, write an assignment whose `predecessorInstanceId` names it, with the legacy manager still running. Call `prepare` | `failed-precondition` naming the predecessor; the legacy manager's `svc.manager` record, its gate revision and its credential family are unchanged; no eviction or freeze request reaches the delivery-admin rail |
| H17 | Stop the legacy manager through its own clean stop, then `prepare`, `activate` and start the platform manager | the legacy record is absent and its gate still names its own principal; the platform gate names `<p_owner>.manager_serve_<instanceId>`; the account public key and issuer are the deployment's existing ones; agents of other owners keep running on their own credentials, and the platform manager refuses to spawn, retire or administer them |
| H18 | Write an assignment whose `instanceId` is the legacy manager's instance id, then call `prepare` and `activate` | refused before any material is issued; the legacy gate and record are unchanged |

## 11. Residual risk

The door does not provision or retire an agent owned by a `u_` user; a platform that needs one
uses the existing user-bound path, a human's `supervise`-scoped manager with `enrollManagedAgent`.

The door trusts its in-process caller. In a split layout the platform's caller-bound channel is the
boundary. It must bind each caller (peer uid) to one assignment, and the door still refuses any
envelope for another account, instance, lifecycle or revision. A compromised control worker can
therefore drive the door only for its own assignment, which is the authority it already holds. In
the uid-split hosted layout ([hosted runtime contracts](hosted-runtime-contracts.md)), a context
slot holds no signer and reads only enumerated account-scoped material through a peer-uid-checked
adapter. The service door adds one closed request type to that adapter and no secret.

The assignment observer is a host callback. A backend that writes a wrong assignment issues
authority to the wrong instance. The door narrows that to one account per context, one instance and
one lifecycle per row, and the gate's single principal. It cannot make a wrong backend write right.

The predecessor check runs at `prepare` and `activate`. It cannot stop a legacy manager that its own
operator starts again later, and it sees no legacy manager the assignment does not name. The
platform's transition must name the predecessor and disable the legacy start path. A legacy
manager started again registers its own instance under its own owner beside the control instance.
That is a second manager in the space but not a takeover: the service view never reaches the legacy
manager's gate, and the legacy restart re-registers only its own instance.
