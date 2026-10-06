# Delegated user launch intent

Status: the `@cotal-ai/core` wire types and parsers of section 4.1, the `@cotal-ai/auth` decisions
of section 4.2 and the `@cotal-ai/manager` members of section 4.3 shipped in 0.62.0, and the host
incarnation members of section 11 in 0.65.0.
The decisions are host policy, as the #1972 enrollment decisions are: a host that owns an intent
store and the enrollment and retirement writers composes them on its own routes, and passes the
holder's `executeDelegatedUserIntent`. Stock still has no such route, no record store and no
writer. Section 11 lists each symbol's status.

The source inventory below was checked at `d00f18cd62f5933c7dceb93b56559498b66656bc` (v0.58.0 plus
later fixes on main). The platform holder this record extends is the `p_` holder of
[platform-pooled-control-authority.md](platform-pooled-control-authority.md) as it reads at commit
`2392055fef5777a4c1c8bcbac6621aefd9e9705e`. That record is referenced here and not edited. Its R8
and H13 rows read the same at the later `1e32152050fb83cf6d0c2c04f1564b5183d558a4` and at
`6ca4d8e0f48d711769ea2e3710338e1e23dab82f`, where it landed on main with its door.

The question is how a platform control holder can run one launch or one retirement that a real,
signed-in user asked for, so that the intent and the resulting agent stay the user's. The answer is
one user-authored intent record, admitted on the host's existing authenticated human route, and one
holder-side execution request that consumes it once. The host then runs the writers it already runs
for a user's own remote manager, with the user's owner and the user's spawning principal. The holder
contributes a runtime and a registration. It contributes no authority.

## 1. What a user-initiated launch does today

Two arms in `Manager.provisionUserAgent` (`implementations/manager/src/manager.ts`) decide every
user-mode spawn. The line numbers are those of `d00f18cd6`. The same statements stand at the v0.58.0 tag
(`ed9534a3135553c0a6c91a3305d13388d5b55c3e`) at `manager.ts:3642-3647` (routing, owner, refusal),
`3673-3683` (the grant with its parent) and `3807-3809` (the hosted owner refusal).

| Arm | Where | Owner | Ledger row | Refusal |
|---|---|---|---|---|
| local | `manager.ts:3736-3741` | `opts.specOwner`, else the spawner principal's owner when it is `u_` | `provider.grantAgent` (`manager.ts:3766-3779`) with `parent: opts.spawner`, then `provisionAgentDurables` keyed by owner, actor and lifecycle UID | no owner: `user-auth space "<space>": no owner for this spawn - …` |
| hosted (#1972) | `manager.ts:3735`, `enrollUserAgent` at `3850` | the host's, returned as `material.owner`; the request carries no owner (`manager.ts:3886-3897`) | written by the host platform, which owns the ledger writer and durables | `the host enrolled the agent under owner <owner>, not the spawning owner <owner>` (`manager.ts:3900-3902`), when the spawning owner is `u_` |

The ledger row the local arm writes goes through `grantManagedActor`
(`implementations/auth/src/ledger.ts:396`). That function calls `assertWithinSpawnerGrant(dir, row,
"spawn")` (`ledger.ts:305`, called at `400`), the envelope walk. The walk climbs the `parent` chain,
requires every link to exist and to share the owner, and refuses scope, read, post or role beyond
the parent's row. An `admin` ancestor or a parentless row ends the walk. The same walk runs again at
every agent bearer exchange (`ledgerAuthorizeAgentExchange`, `ledger.ts:570`), so narrowing the
spawner bites its agents at their next bearer.

The hosted arm's host doors decide only. `authorizeRemoteManagedAgentEnrollment` and
`authorizeRemoteManagedAgentPrepareRetirement` (`implementations/auth/src/managed-agent-enrollment.ts`)
require scope `supervise` and an open gate whose principal is `<authenticated owner>.manager_serve_<instanceId>`,
plus a matching serve epoch and registration proof. Prepare-retirement also requires
`target.owner` to equal the authenticated owner and `opId` to equal
`managedRetirementOpId(target.lifecycleUid)`. Stock `dispatchManagerAuthorityRequest`
(`implementations/auth/src/service.ts:1725-1729`) refuses all four managed-agent kinds with
`unimplemented`. A host that owns the writers intercepts them on its own route.

So a `u_` agent comes up only under a principal of that user: the user's own ctl spawn through the
host's local manager, or the user's own `supervise`-scoped remote manager. Any other authenticated
principal is refused on the user's instance by the gate principal check, and the only enrollment the
doors admit for it is under its own owner, which would relabel the agent. The enrollment target is
closed and has no owner or intent field. The `p_` holder did not exist at `d00f18cd6`. It landed with
its door at `6ca4d8e0f` and changes none of this: R8 binds it to its own owner (section 8).

## 2. Scope

In scope: one user-authored intent request and its admission decision, one holder execution request
and its decision, the host-held intent record they share, one manager callback and one spawn input
that route a launch to the execution request, one manager method for retirement, the refusals, and
the hand acceptance. SPEC §13 gains one new subsection, §13.16.

Out of scope: any change to the `manager-service` view or the `platform-control` view of the
platform-control record, any change to its R1 to R9 or its H1 to H15, a standing delegation grant,
an admin or operator path, a generic delegation framework, child bootstrap outside the holder's
filesystem (#2420 owns that and has no frozen design yet), release.

## 3. The composition

| Step | Who | Over what | Authority |
|---|---|---|---|
| Admit | the user's client | the host's authenticated human route, the transport `POST /manager-service-authority` already uses (`{ idpToken, request }`) | the user's verified IdP subject and the user's own fresh ledger row |
| Record | the host | its own intent store, create-only | the admission decision |
| Execute | the holder | the platform's own route for the holder, the one the platform-control record gives the managed-agent kinds | the intent record, bound to the holder's current registration |
| Write | the host | its existing enrollment or retirement writers | the intent's owner and spawning principal |

The holder never holds a human login, a copied token, an IdP token or a synthesized `supervise`.
The host never signs anything for the holder that the hosted enrollment does not already return.
The intent carries no permission, profile, subject, lifetime or claim.

## 4. Declarations

Written here so a producer can adapt against them. Section 11 says which of them ship.

### 4.1 `@cotal-ai/core` (`packages/core/src/remote-manager-authority.ts`)

```ts
/** The launch a user asks for. It is the enrollment target without the token digest: the user
 * never sees the agent's token, and the holder that generates it adds only the digest. */
export type DelegatedUserLaunchTarget = Omit<RemoteManagedAgentEnrollmentRequest["target"], "tokenHash">;

/** One operation on one target. There is no list form and no wildcard. */
export type DelegatedUserIntentOperation =
  | { operation: "launch"; target: DelegatedUserLaunchTarget }
  | { operation: "retire"; target: RemoteManagedAgentPrepareRetirementRequest["target"] };

/** Upper bound on an intent's life, enforced by the host at admission and at execution. */
export const DELEGATED_USER_INTENT_MAX_TTL_SECONDS = 300;

/** Closed request a signed-in user sends on the host's authenticated human route. It carries no
 * owner, scope, IdP field, lifecycle UID of the holder, serve epoch, profile or lifetime. The host
 * derives the owner from the verified IdP subject and binds every holder coordinate itself. */
export interface DelegatedUserIntentRequest {
  v: 1;
  kind: "delegated-user-intent";
  space: string;
  /** The user's own actor. Its fresh ledger row admits the intent, and its principal becomes the
   * launched agent's ledger `parent`, as the spawner principal does on a user's own spawn. */
  actor: string;
  /** The account the user means. It must equal the serving authority context's account. */
  accountPublicKey: string;
  /** The platform control instance the user asks to execute it. */
  instanceId: string;
  requestId: string;
  intent: DelegatedUserIntentOperation;
}

/** The host's answer to the user. Every coordinate is host-observed at admission. */
export interface DelegatedUserIntentAdmission {
  v: 1;
  kind: "delegated-user-intent";
  space: string;
  owner: string;
  /** The user's own actor that admitted the intent. It is never the target's actor. */
  actor: string;
  requestId: string;
  /** Host-generated with `mintLifecycleUid`. Never caller-selected. */
  intentId: string;
  accountPublicKey: string;
  instanceId: string;
  managerLifecycleUid: string;
  assignmentRevision: number;
  /** The holder's gate process epoch at admission. Null only for a retirement admitted while the
   * launching holder is gone (section 7.2). */
  serveEpoch: number | null;
  intent: DelegatedUserIntentOperation;
  /** ISO time, at most DELEGATED_USER_INTENT_MAX_TTL_SECONDS after admission. */
  expiresAt: string;
}

/** Closed request the holder sends to execute one admitted intent. It names the intent and the one
 * target it expects, and nothing the user did not already fix. */
export interface RemoteDelegatedUserIntentExecutionRequest {
  v: 1;
  kind: "manager-delegated-user-intent-execution";
  space: string;
  /** The shipped request builders' envelope constant, as the platform-control record fixes it for
   * the holder. It keys the registration proof and is never read as a ledger principal. */
  actor: "cli";
  accountPublicKey: string;
  assignmentRevision: number;
  instanceId: string;
  managerLifecycleUid: string;
  requestId: string;
  registrationProof: string;
  serveEpoch: number;
  identities: RemoteManagerAuthorityRequest["identities"];
  intentId: string;
  execute:
    | { operation: "launch"; target: { actor: string; tokenHash: string } }
    | { operation: "retire"; target: RemoteManagedAgentPrepareRetirementRequest["target"] };
}

export type RemoteDelegatedUserIntentExecutionResult =
  | {
      v: 1;
      kind: "manager-delegated-user-intent-execution";
      operation: "launch";
      space: string;
      instanceId: string;
      managerLifecycleUid: string;
      requestId: string;
      serveEpoch: number;
      intentId: string;
      /** The hosted enrollment's material, unchanged. `material.owner` is the intent's `u_` owner. */
      material: RemoteManagedAgentEnrollmentResult["material"];
      runtimeIntent?: { state: "reserved" };
    }
  | {
      v: 1;
      kind: "manager-delegated-user-intent-execution";
      operation: "retire";
      space: string;
      instanceId: string;
      managerLifecycleUid: string;
      requestId: string;
      intentId: string;
      target: RemoteManagedAgentPrepareRetirementRequest["target"];
      /** managedRetirementOpId(target.lifecycleUid), recomputed by the host. */
      opId: string;
      retired: boolean;
    };

export function parseDelegatedUserIntentRequest(raw: unknown): DelegatedUserIntentRequest;
export function parseRemoteDelegatedUserIntentExecutionRequest(raw: unknown): RemoteDelegatedUserIntentExecutionRequest;
export function parseRemoteDelegatedUserIntentExecutionResult(
  raw: unknown,
  request: RemoteDelegatedUserIntentExecutionRequest,
): RemoteDelegatedUserIntentExecutionResult;
```

### 4.2 `@cotal-ai/auth`

```ts
/** The host's record of one admitted intent. The host is its only writer: create-only at admission,
 * then one revision-pinned CAS from `admitted` to `consumed` that writes `execution` before any
 * effect, then revision-pinned CASes only: a sweeper's claim, the one write that sets `outcome`,
 * and the executor's `released`. */
export interface DelegatedUserIntentRecord extends Omit<DelegatedUserIntentAdmission, "v" | "kind" | "requestId"> {
  v: 1;
  /** `<owner>.<actor>`: the launched agent's ledger parent, and the principal the envelope walk starts from. */
  parent: string;
  state: "admitted" | "consumed";
  /** Written by the consuming CAS and never changed after. Absent while `admitted`. */
  execution?: DelegatedUserIntentExecutionPin;
  /** The host incarnation that claimed the execution for its executor because it believes that
   * executor gone (section 6, Flight). Absent until a sweeper claims; a later sweeper may replace it. */
  sweptBy?: DelegatedUserIntentIncarnation;
  /** Set once, when the pinned execution ends. Absent while it runs or while the host recovers it. */
  outcome?: "enrolled" | "retired" | "aborted";
  /** Set once, only by the executor's own flight, after a sweeper's claim: the flight has stopped
   * and revoked any grant at the pinned UID (section 6, Alias hold). Absent on every other record. */
  released?: true;
}

/** True while `record` holds the alias `(record.owner, record.intent.target.actor)`: consumed with
 * no `outcome`, or claimed by a sweeper (`sweptBy`) and not yet `released`. */
export function delegatedUserIntentHoldsAlias(record: DelegatedUserIntentRecord): boolean;

/** One run of one host process, as SPEC §13.7 names an executor. An instance id without its process
 * epoch names a process, never the run of it that holds a flight. */
export interface DelegatedUserIntentIncarnation {
  instanceId: string;
  /** The process epoch (§13.1) of the host's own serving instance, advanced by every restart. */
  processEpoch: number;
}

/** What the consuming CAS fixes before any effect, so that a retry, a lost answer or a host restart
 * resumes the same execution at the same lifecycle. */
export interface DelegatedUserIntentExecutionPin {
  /** The holder request that consumed the record. Null when the host consumed a holder-gone retirement itself. */
  requestId: string | null;
  serveEpoch: number | null;
  /** Launch: selected by the host before the CAS, and the only UID its writer enrolls. Retire: the target's. */
  lifecycleUid: string;
  /** Launch only: the holder's token digest. */
  tokenHash?: string;
  /** Retire only: managedRetirementOpId(lifecycleUid). */
  opId?: string;
  /** The host incarnation whose flight consumed the record: the execution's only executor. */
  executor: DelegatedUserIntentIncarnation;
}

/** In-process executions keyed by intentId, each bound to its pin, as RetirementFlights binds a
 * retirement to its coordinates. A host process holds at most one flight per intent. */
export type DelegatedUserIntentFlights = Map<string, {
  pin: DelegatedUserIntentExecutionPin;
  promise: Promise<RemoteDelegatedUserIntentExecutionResult>;
}>;

/** Join the flight for `intentId`, or start `run` and register it. Returns undefined when that
 * intent is in flight under a different pin: the caller refuses with `conflict` and starts nothing. */
export function joinOrStartDelegatedUserIntent(
  flights: DelegatedUserIntentFlights,
  intentId: string,
  pin: DelegatedUserIntentExecutionPin,
  run: () => Promise<RemoteDelegatedUserIntentExecutionResult>,
): Promise<RemoteDelegatedUserIntentExecutionResult> | undefined;

/** The platform control door's assignment observer as it shipped (`PlatformControlDeps["observeAssignment"]`,
 * `implementations/auth/src/platform-control.ts:91` at `6ca4d8e0f`), unchanged. It is keyed by account,
 * which has at most one current row, and both decisions require that row to name the intent's instance. */
export type ObservePlatformControlAssignment = (space: string, accountPublicKey: string) => Promise<PlatformControlAssignment | null>;

export interface AuthorizeDelegatedUserIntentAdmissionArgs {
  request: DelegatedUserIntentRequest;
  space: string;
  accountPublicKey: string;
  /** Derived from the verified IdP subject with deriveOwnerForIdpSubject. Never read from the request. */
  owner: string;
  /** This host's ledger directory. The decision reads the actor's row itself. */
  dir: string;
  observeAssignment: ObservePlatformControlAssignment;
  observeManagerGate: ObserveManagerGate;
  /** The host's launch record of this owner whose `execution.lifecycleUid` is `lifecycleUid`, read fresh. Retire only. */
  observeLaunchRecord(owner: string, lifecycleUid: string): Promise<DelegatedUserIntentRecord | null>;
  /** The host's records of this owner whose `intent.target.actor` is `actor`, read fresh. Launch only. */
  observeAliasRecords(owner: string, actor: string): Promise<DelegatedUserIntentRecord[]>;
  /** platformControlOwner(...) for this space and account, from the platform-control record. */
  platformOwner: string;
  now: number;
}

/** Decides one admission. Writes nothing and mints nothing. Returns the record the host persists. */
export function authorizeDelegatedUserIntentAdmission(
  args: AuthorizeDelegatedUserIntentAdmissionArgs,
): Promise<DelegatedUserIntentRecord>;

export interface AuthorizeDelegatedUserIntentExecutionArgs {
  request: RemoteDelegatedUserIntentExecutionRequest;
  space: string;
  accountPublicKey: string;
  platformOwner: string;
  /** The host's record for request.intentId, read fresh. Null is an absent intent. */
  intent: DelegatedUserIntentRecord | null;
  observeAssignment: ObservePlatformControlAssignment;
  observeManagerGate: ObserveManagerGate;
  proofSecret: string | Uint8Array;
  now: number;
}

/** The only facts an execution decision carries, all checked for the current request. */
export interface DelegatedUserIntentDecision {
  intentId: string;
  requestId: string;
  serveEpoch: number;
  owner: string;
  parent: string;
  instanceId: string;
  /** True when the request equals the record's `execution` pin: the host joins that execution's
   * flight, or answers from its outcome, and writes no second CAS. */
  resume: boolean;
  operation: "launch" | "retire";
  target: DelegatedUserLaunchTarget | RemoteManagedAgentPrepareRetirementRequest["target"];
  /** Launch only. */
  tokenHash?: string;
  /** Retire only: managedRetirementOpId(target.lifecycleUid). */
  opId?: string;
}

/** Decides one execution. Writes nothing; the host consumes the record, pinning the execution, before
 * acting on the decision. */
export function authorizeDelegatedUserIntentExecution(
  args: AuthorizeDelegatedUserIntentExecutionArgs,
): Promise<DelegatedUserIntentDecision>;
```

### 4.3 `@cotal-ai/manager`

```ts
// ManagerOptions["remoteAuthority"] gains one optional member:
/** Host-owned execution of one admitted delegated user intent. Absent: a delegated spawn and a
 * delegated retirement are refused before any request. */
executeDelegatedUserIntent?: (
  execute: RemoteDelegatedUserIntentExecutionRequest["execute"] & { intentId: string },
) => Promise<RemoteDelegatedUserIntentExecutionResult>;

// StartAgentOpts gains one optional member, set only by the composition root's in-process call:
/** Launch under an admitted intent. The ctl spawn handler never maps a payload field into it. */
delegatedIntent?: { intentId: string; owner: string; parent: string };

// Manager gains one method:
/** Retire one agent this manager launched under a delegated intent, through the host. It sends the
 * request for the UID of the slot or hold `name` names, and only on `retired: true` for that target
 * and its op id stops the slot and frees the name. Any other answer leaves the slot running or the
 * name held. */
retireDelegatedAgent(name: string, intentId: string): Promise<ControlReply>;
```

With `delegatedIntent` set, `provisionUserAgent` takes the hosted arm with
`executeDelegatedUserIntent` in place of `enrollManagedAgent`. It sends
`{ intentId, operation: "launch", target: { actor: name, tokenHash } }` and binds the answer with the
existing checks: `material.actor` must equal `name`, and the spawning owner is
`delegatedIntent.owner`, so the existing `the host enrolled the agent under owner <owner>, not the
spawning owner <owner>` sentence refuses any other owner. The spawn record stores
`userOwner: material.owner` and `spawner: delegatedIntent.parent`. A lost answer is retried with the
same request, the same `requestId` and digest, while the manager still holds the staged token, and
the host joins it to the execution's flight (section 6). If the manager gives up and shreds the
token, the host still holds the enrolled lifecycle, and the user retires it with a retirement intent
(section 7).

A delegated launch with a `supervise` policy is refused, and a delegated slot arms no session
recovery, because a delegated agent is never restarted (section 8). A delegated slot's stop, exit,
reap or rollback runs none of the holder's own retirement callbacks.
Its name stays held until `retireDelegatedAgent` receives `retired: true` for that UID, and a
same-name spawn is refused meanwhile. A launch that fails after the host's answer passed the owner,
actor and UID checks, such as a secret write, a refused bearer preflight or a connector that cannot
build the launch, holds its name at the enrolled UID the same way. The manager records that hold
when the answer passes, before any later local step, so no later failure can release the name. A
local secret the manager then fails to remove is named in the refusal, whatever value the store
rejected with.
`retireDelegatedAgent` stops a running slot only after `retired: true` for the target and op id it
sent, because the host's order closes the provider handle (section 7), so a refused or unconfirmed
retirement leaves the agent running. A manager with neither a slot nor a hold for the name, such as
a restarted holder, refuses the call, and the user's retirement then takes the holder-gone branch
(section 7.2), because a restart moved the gate's epoch.

## 5. Admission

The user's client posts `{ idpToken, request }` on the host's authenticated human route. Stock
`dispatchManagerAuthorityRequest` refuses `kind: "delegated-user-intent"` with `unimplemented`,
because admission writes host storage. A host that owns the intent store intercepts the kind on its
own route. One admission runs in this order, and every refusal writes nothing:

1. The host verifies the IdP token (`verifyIdpToken`) and derives the owner
   (`deriveOwnerForIdpSubject`). A missing or invalid token is refused before parsing. The token is
   not stored, forwarded or put in the record.
2. The request is closed. An unknown field, including `owner`, `idpToken`, `scope`, `serveEpoch` or
   `tokenHash`, is `bad-request`. `space` and `accountPublicKey` must equal the context's own.
3. The host reads the user's row fresh (`ledgerAuthorizeGrant(dir)(owner, request.actor)`). It must
   carry `spawn`, the scope a user's own ctl spawn and owner-domain stop need; a missing row or a
   row without `spawn` is `permission-denied`. No `supervise` is read, required or written.
4. Launch: `observeAssignment(space, accountPublicKey)` is read fresh. It must exist, be `assigned`,
   name this account and name `instanceId` as its instance. `observeManagerGate(instanceId)` must be open with principal
   `<platformOwner>.manager_serve_<instanceId>`. The host records the assignment's `lifecycleUid`
   and revision and the gate's process epoch. A missing, revoked or foreign assignment, or a gate
   that names another principal, is `permission-denied`. A gate that is not open is
   `failed-precondition`. An observer error is `unavailable`.
5. Launch: the target's read list is resolved with `resolveReadAcl` (`@cotal-ai/core`), the
   function `provisionAgentDurables` resolves it with, so an empty `allowSubscribe` reads exactly
   `subscribe`, and a subscription outside the resolved list is `permission-denied`. The target's
   scope, resolved read list, post list and role must pass `assertWithinSpawnerGrant` as a dry check
   against the parent `<owner>.<actor>`, refused with the walk's own sentence. The authoritative
   walk and the writer's other refusals, such as an interactive row of the same name, run again at
   the write (section 6). No record from `observeAliasRecords(owner, target.actor)` may hold the
   alias (`delegatedUserIntentHoldsAlias`, section 6, Alias hold); one that does is
   `failed-precondition`.
6. Retire: `target.owner` must equal the owner (`permission-denied`).
   `observeLaunchRecord(owner, target.lifecycleUid)` must return a record of this owner with
   `intent.operation: "launch"`, `outcome: "enrolled"`, `execution.lifecycleUid` equal to
   `target.lifecycleUid`, `intent.target.actor` equal to `target.actor`, and `instanceId` equal to
   the request's. The record's own `actor` is the user actor that admitted the launch and is never
   compared with the target. A lifecycle the user's own manager launched has no such record. It is
   retired through that manager's path and is refused here as `failed-precondition`, as is a launch
   whose execution has not ended or ended `aborted`.
   The host then reads the assignment and gate as in step 4. When the launching holder is present
   (section 7.2 defines gone), the record binds its current coordinates. When it is gone, the record
   binds the launch record's `managerLifecycleUid` and `assignmentRevision` with `serveEpoch: null`.
7. The host generates `intentId`, sets `expiresAt` to at most
   `DELEGATED_USER_INTENT_MAX_TTL_SECONDS` ahead, and creates the record with `state: "admitted"`.
   A create that loses is refused.

## 6. Launch execution

The holder posts `RemoteDelegatedUserIntentExecutionRequest` on the platform's route for the holder.
The platform-control door refuses this kind as an unknown kind (`bad-request`), so its closed union
stays as written. One execution runs in this order, and every refusal before the CAS writes nothing:

1. The request is closed and its `actor` is the literal `"cli"`. `space` and `accountPublicKey` must
   equal the context's.
2. The record for `intentId` is read fresh. An absent record, or an `admitted` one past
   `expiresAt`, is `failed-precondition`. A `consumed` record is `failed-precondition` unless the
   request is a retry of the execution that consumed it: its `requestId` and `serveEpoch`, and a
   launch's token digest, equal the record's `execution`. A retry runs steps 3 to 5
   again, and a refusal there answers that request only and leaves the record and the execution as
   they are. A retry that passes writes no second CAS (`resume: true`). It is answered from the
   record's `outcome` when one is set, and otherwise joins the execution's flight (Flight, below)
   and receives the flight's answer. A retry never runs step 7, step 8 or the section 7 order itself.
3. `instanceId`, `managerLifecycleUid`, `assignmentRevision` and the operation must equal the
   record's. Any difference is `permission-denied`.
4. `observeAssignment(space, accountPublicKey)` is read fresh. It must exist and be `assigned`. Its space,
   account, instance id and `assignmentRevision` must equal the record's, and its `lifecycleUid`
   must equal the record's `managerLifecycleUid`; step 3 made both equal to the request's. A null,
   `revoked` or moved assignment is `permission-denied`, as the platform-control door's own
   assignment check refuses it (that record's section 3.2 step 2 and H4). An observer error is `unavailable`. The gate must be open
   with principal `<platformOwner>.manager_serve_<instanceId>`. A gate epoch different from the
   request's `serveEpoch` is `conflict`. A request epoch different from the record's `serveEpoch`
   is `permission-denied`. The registration proof must match
   `remoteManagerCurrentRegistrationProof(proofSecret, platformOwner, request, gate)`.
5. `execute.target.actor` must equal the record's target actor. A different target is
   `permission-denied`.
6. The host selects the lifecycle UID as its enrollment writer does, starts the execution's flight
   with `joinOrStartDelegatedUserIntent`, and the flight CASes the record from `admitted` to
   `consumed` at the revision step 2 read. The same write sets `execution` to the request's
   `requestId` and `serveEpoch`, that UID, the token digest, and this host process's incarnation as
   `executor`, which the handle's `registerHostIncarnation` returned at this process's start. A
   lost CAS is `conflict`, the flight ends, and nothing is enrolled.
7. The CAS is the execution's commit. The reads in steps 2 and 4 are not fences (SPEC §13.1: a read
   is never a fence), so the host runs step 4 again after the CAS and before any effect. A refusal
   there runs the compensation (below) at the pinned UID, then sets `outcome: "aborted"` and answers
   with that refusal's code. A reassignment, a revocation or a gate move that lands before this
   second read aborts the execution. One that lands after it is ordered after the commit and refuses only later
   executions, as the platform-control record's revocation refuses only the next door call. The
   agent such an execution leaves is the user's, and its holder counts as gone (section 7.2).
8. The host first activates the lifecycle at the pinned UID with the handle's
   `activateManagedLifecycle`, which runs `activateLifecycleAtUid`
   (`implementations/auth/src/lifecycle-registry.ts:511`) with the `managerInstance` the agent's
   bearer exchange passes (`auth-service:<space>`) and mints nothing. The
   alias head is then `active` at that UID and its issuance gate is open before any row or durable
   exists. A refusal there, such as the alias being `active` or `retiring` at another UID, runs the
   compensation, whose own activation then follows the Compensation paragraph's rule for an alias
   live at another UID. The host then runs the enrollment writer it already runs
   for `manager-managed-agent-enrollment`, with the decision's values and the pinned UID and digest.
   It writes the ledger row through `grantManagedActor`, provisions the lifecycle-keyed durables,
   sets `outcome: "enrolled"` and returns the hosted enrollment material. The host MUST use that one
   writer for both doors, so a delegated row and a row from the user's own remote manager cannot
   diverge. The agent's first bearer exchange finds the head active at its UID, and
   `ensureRootCredential` mints its root credential there as it does for any completed activation.

**Flight.** From the CAS on, the host owns the execution, whoever presented it, and runs it in one
flight: an in-process task keyed by `intentId` in a `DelegatedUserIntentFlights` map, joined by every
request equal to the pin, as `joinOrStartRetirement` joins a managed retirement by its op id. Only
the flight runs step 7, step 8 and the section 7 order for the record, and only the flight sets
`outcome` and `released`. Every record write after the consuming CAS is a CAS pinned to the revision the writer
last observed, so a writer that lost the record to another write can neither set nor overwrite
`outcome`. A flight answers only from the outcome its own CAS wrote. When that CAS loses, it re-reads
the record and answers from the outcome found there, or `conflict` when there is none, and never
answers material it did not commit. The manager frees or keeps its alias only on such an answer.

The execution has one executor, the incarnation the consuming CAS pinned, and recovery follows the
executor and sweeper roles of SPEC §13.7:

- The executor stops every flight before its next effect once the handle's `awaitHostFence`,
  armed with its incarnation at start, resolves: a later registration or barrier has fenced it.
- The executor, in the same process run, starts a new flight for the record when its earlier
  flight ended with no `outcome`, for example on an `unavailable` writer error, at its next scan of
  consumed records or on a retry. That flight resumes at step 7.
  When the re-check passes, it re-runs step 8 from its activation with the pinned UID and digest.
  `activateLifecycleAtUid` adopts the same alias's partial activation at that UID and returns at
  once for a completed one, `grantManagedActor` is an upsert keyed by owner and actor, and the
  durables are keyed by the UID, so a second run writes the same head, row and durables. When the
  re-check or the writer now refuses, for example because the holder is gone or the user narrowed
  `cli`, it runs the compensation below and sets `outcome: "aborted"`. Every refusal after the
  consuming CAS takes that path, the first flight's included, and none sets `aborted` directly: a
  flight that resumes at step 7 cannot tell from its own state whether an earlier flight of the same
  execution activated the UID or wrote its row, and the record pins no such phase. On a first
  attempt the compensation activates a UID with no row behind it and retires it at once. Before each effect of step 8 and
  before its `outcome` CAS, the executor's flight re-reads the record, and a `sweptBy` it did not
  write ends the flight as the Alias hold paragraph says.
- Any other incarnation is a sweeper. A restarted host is one, because its restart advanced its
  process epoch. A sweeper acts only on a consumed record with no `outcome`, and only when it
  believes the executor gone: the executor instance's serving issuance gate, read with the handle's
  `observeHostGate`, is absent, not `open`, or at another process epoch. It first CASes `sweptBy`
  to its own incarnation and changes nothing else; a lost claim starts nothing. It may then take
  only a terminal edge that removes authority: for a launch, the compensation below and then `outcome: "aborted"`; for a retirement, the section 7
  order and then `outcome: "retired"`. A sweeper never runs step 7 or step 8, because advancing a
  launch on a gone executor's behalf is the split brain §13.7 forbids. It always compensates a
  launch, because it cannot know how far step 8 got.

**Compensation.** A launch is undone by the section 7 order at the pinned UID, with one step added
before the terminal barrier: `activateLifecycleAtUid` at that UID. The uid-exact prepare runs first,
so the gate the compensator opens has no row behind it. A bearer exchange at that UID needs a row
there, so it can mint only from a row a late executor writes after the prepare, and the barrier
retires whatever that mints. The activation adopts a partial activation of the same alias and UID (its won
reservation or its frozen activation gate), returns at once for a completed one, and otherwise
completes it. Before it activates, the compensator reads the head and the issuance gate at the
pinned UID, and it never activates once a retirement there has begun: the head is `retiring` or
`retired` at that UID, or the gate is `frozen` or `retired` by `managedRetirementOpId(uid)`. The
handle's `activateManagedLifecycle` is that read: it reads both before any write and refuses each of
those states, `failed-precondition` for a retiring head or a gate frozen by retirement and
`permission-denied` for a retired gate, and the compensator then goes to the managed retire door. The
barrier creates its durable intent (`retirement-barrier.ts:615`) and freezes the gate
(`retirement-barrier.ts:661`) before it moves the head (`retirement-barrier.ts:670`), so a
compensation interrupted between those writes leaves the head `active` over a gate frozen by
retirement, and `activateLifecycleAtUid` refuses that freeze as `failed-precondition`
(`lifecycle-saga.ts:433-440`). The compensator goes straight to the managed retire door instead. The
door finds the head active at the UID and joins the barrier under the same derived op id, which
resumes from its durable intent and recognizes its own freeze (`retirement-barrier.ts:597-630`) or
its own terminal gate (`retirement-barrier.ts:632-648`). On every other path the barrier finds the
active head and the open gate it requires (`retirement-barrier.ts:603-610`), whatever point the
executor reached: after the consuming CAS
with nothing written, inside its activation, or after its ledger write and before any bearer
exchange. Terminal confirmation is the managed retire door's `retired: true` or
`alreadyRetired: true` at that UID. Its `notStarted` answer is never terminal confirmation, and a
compensator that receives it starts the order again from the prepare. A door `conflict` because a
row reappeared at that UID also repeats the order from the prepare. When the activation is refused
because the alias is `active` or `retiring` at another UID, the pinned UID has never activated, and
no row or durable exists there, because step 8 writes them only after its activation. The record
then keeps no `outcome`, the alias stays held, and the compensator tries again at its next scan.
The attempt completes once that other incarnation retires. A UID the barrier retired never
activates again: `activateLifecycleAtUid` refuses its terminally retired gate (`lifecycle-saga.ts:442-447`).

A sweeper whose belief is wrong is still safe. A claim is pinned to a revision with no `outcome`,
so it loses to an executor that committed first, and the executor's later `outcome` CAS loses to
the claim. The sweeper's terminal barrier freezes the issuance gate at the pinned UID before it retires
the lifecycle (§13.1), so a row or durable the executor writes there afterwards can mint nothing,
and `retired` is terminal for that UID. An executor that is also compensating runs the same derived
op id and joins the same barrier operation. Every launch interleaving ends at that UID either
`enrolled` by the executor with no claim, or retired with `outcome: "aborted"`. The alias hold
below keeps that late executor from writing over any other incarnation of the alias.

**Alias hold.** A consumed record holds its target alias `(owner, intent.target.actor)` on the host
from its consuming CAS. A record whose executor set `outcome` releases the alias with that write,
because the outcome is the executor flight's last effect and no flight starts again on a record
with an outcome. A record a sweeper claimed stays held after its outcome. The executor a wrong
belief left running may still be paused before an alias-keyed write, and `grantManagedActor` is an
unconditional upsert by owner and actor (`ledger.ts:396-416`) that the retired gate at the old UID
does not fence. Only two actors release such a record:

- the executor's own flight: when its re-read finds `sweptBy` or its `outcome` CAS loses, it stops
  before any further effect, runs the uid-exact prepare of section 7 step 1 at the pinned UID, which
  revokes a row it wrote after the sweeper's prepare, and then, once the record has its outcome,
  CASes `released: true`. The prepare cannot touch another
  incarnation's row, because the hold keeps every other writer off the alias;
- an operator, by hand, after confirming that the executor process has exited and running the same
  prepare. §13.7 leaves `draining → released` to an operator for the same reason: no actor can
  attest that another incarnation is gone. This record adds no door for it.

While `delegatedUserIntentHoldsAlias` is true for any record of the alias, launch admission for it
is `failed-precondition` (section 5, step 5), and the host's one enrollment writer refuses, for
either door, any enrollment of that alias other than the holding record's own execution, with
`failed-precondition` and no write. The writer reads the hold fresh before it writes. A hold stops
nothing already enrolled, and the user can launch under another name at once. A retirement record
holds its alias the same way, because its uid-exact prepare also writes by owner and actor.

A retry that finds no flight for the record in this process starts one in the role this process
holds: the executor's new flight, or a sweeper's when it believes the executor gone. Otherwise it is
answered `unavailable` and starts nothing. A holder retry (step 2) gets the same material once the
outcome is `enrolled`, and `failed-precondition` once it is `aborted`.

The row the writer produces, compared with the row the user's own manager writes for the same
requested target from the same spawning principal:

| Field | User's own spawn (local arm) | Delegated launch |
|---|---|---|
| `owner` | spawner's `u_` (`manager.ts:3737`) | record `owner`, derived from the user's IdP subject at admission |
| `actor` | the requested name | the record's target actor, which the holder's name must equal |
| `parent` | the spawner principal (`manager.ts:3776`) | record `parent`, the user's own `<owner>.<actor>` |
| `scope` | requested capabilities filtered to `spawn`, `run`, `admin`, `role:<r>` (`manager.ts:3752`) | the record's target capabilities, same filter |
| `allowSubscribe`, `allowPublish`, `role`, `label` | requested values | the record's target values |
| attenuation | `assertWithinSpawnerGrant` from the parent, at write and at every bearer exchange | the same function from the same parent |
| durables and membership | `provisionAgentDurables` keyed by owner, actor, UID, with `subscribe` | the same call with the record's values |
| `lifecycleUid`, `tokenHash`, `grantedAt` | fresh per incarnation | fresh per incarnation |

Every field except the last row is equal for equal inputs. The delegated launch activates the
lifecycle before its row, and the user's own spawn activates it at the agent's first bearer
exchange. By that exchange both have the same head and gate, and neither is a ledger field. The holder is not on the agent's
delegation chain, so no envelope walk ever reads a holder row. Model budget is not a Cotal field at
this head: `ActorRow` and the enrollment types carry none. A host that meters model use per owner
reads the agent's owner, which is the user's `u_`. This design adds no budget field and no
service-principal accounting path.

## 7. Retirement

Retirement keeps the #1972 order and its gate semantics. The host runs it in this order, whoever
presents the intent:

1. uid-exact prepare: revoke the managed grant for `(owner, actor)` at `target.lifecycleUid` only,
   and complete the resumable release with that UID unchanged;
2. known-handle provider closure: close the provider handle the host's runtime record holds for that
   UID, driving the record through `closing` to `closed`; a record in `create-unknown` keeps the
   alias held until the provider resolves it;
3. terminal barrier: run the auth-owned barrier with `managedRetirementOpId(target.lifecycleUid)`
   through the same in-process flight `POST /managed-lifecycle/retire` uses;
4. free the alias and the hosted survivor record only after terminal confirmation, then set the
   intent record's `outcome: "retired"`. Terminal confirmation is `retired: true` or
   `alreadyRetired: true` at that UID, never `notStarted`. A delegated launch that reached
   `enrolled` activated its UID before its row (section 6, step 8), so its barrier always finds an
   active head there.

A failed or uncertain step keeps the alias held. A retry is the same operation on the same UID,
because the operation id is derived and the flight is shared. The consuming CAS pins that UID and
op id in `execution`, so a consumed retirement never refuses its own retry: a request equal to the
pin joins the execution's flight (section 6, step 2), and after a restart a sweeper finishes the
order from the pin (section 6, Flight).

### 7.1 Holder present

The holder sends the execution request with `execute: { operation: "retire", target }`. Steps 1 to 6
of section 6 apply, with step 5 comparing the full `{ owner, actor, lifecycleUid }` and step 6
pinning `target.lifecycleUid` and its op id. Step 7 does not apply: a retirement only removes
authority, so a holder that moves after the CAS does not abort it, and the host finishes the order
whether or not the holder remains. After the CAS the host runs the order above and answers
`retired`. `Manager.retireDelegatedAgent` stops and frees the slot only on `retired: true` for the
target and op id it sent. It never calls `prepareAgentRetirement` or `mintRetirementRequester` for a
delegated agent: those bind to the holder's `p_` owner and would be refused for a `u_` target.

### 7.2 Holder gone

The launching holder is gone when its assignment is absent, `revoked` or at another revision, or its
gate is not open, or the gate's epoch differs from the launch record's. A retirement admitted then is
bound to the launching instance with `serveEpoch: null`. No holder can present it, because execution
step 4 requires a current epoch equal to the record's. The host consumes it itself, with the
admission decision as its only authorization and no execution request, pinning
`{ requestId: null, serveEpoch: null }` with the target's UID, op id and its own incarnation as
`executor`, and runs the same order to the same barrier in a flight. A retirement bound to a holder that is gone before it executes expires
unexecuted; the user admits it again and it takes this branch. A holder that disappears after its execution consumed a record does not
stop the sequence: the host's writer owns it from the CAS on, as #1972 has the host finish a
retirement whose participant disappeared after prepare.

Revoking an assignment ends new executions under it. It does not retire a running delegated agent.
The user retires it with a retirement intent, which takes this branch.

## 8. R8 and H13 stay as written

R8 of the platform-control record says the holder's enrollment, retirement, retained validation and
admin authorization all bind to its `p_` owner, and that a human-owned agent is never provisioned,
retired or administered through the `platform-control` view. That text holds unchanged:

- The `platform-control-authority` envelope's inner union is unchanged. The execution kind is not in
  it, and the door refuses it as an unknown kind. The managed-agent kinds stay `unimplemented` there.
- The authority for a delegated launch is the user's admitted intent. The holder's registration only
  proves which instance and epoch present it. The launched agent is the user's descendant: its ledger
  `parent` is the user's principal and its walk never reaches the holder. The holder's own
  descendants stay `p_`-owned.
- The holder's own `prepareAgentRetirement`, `validateRetainedAgent` and `authorizeAdmin` still bind
  to `p_`. A delegated agent is never preserved across a holder restart, because retained
  validation would refuse it. It carries no restart budget: a restart would re-present a consumed
  intent and be refused.

H13 (a `u_` principal asks the platform manager to spawn, and asks `authorizeAdmin`) still ends in
an owner-mismatch refusal and `authorized: false`. A ctl spawn carries no intent: `delegatedIntent`
is set only by the composition root's in-process call, and the spawn handler never reads it from a
payload. `authorizeAdmin` is unchanged.

## 9. Refusals

| # | Property | Mechanism | Refusal | Clause |
|---|---|---|---|---|
| D1 | Real user authorization only | admission derives the owner from a verified IdP subject on the host's human route and reads the user's own row fresh, requiring `spawn` | no or invalid IdP token, an `owner` field, a `p_` or service caller, a row without `spawn`: refused, nothing written | §13.16 admission |
| D2 | No held login, copied token, synthesized `supervise` or signing RPC | the IdP token is verified and dropped; the record and both requests are closed and carry no token, scope, profile, subject, lifetime or claim; execution returns only the hosted enrollment material | an extra field is `bad-request`; neither door reads or writes `supervise` | §13.16 admission, execution |
| D3 | The agent is the user's | the host's writer uses the record's owner and parent; `grantManagedActor` runs the envelope walk from the user's principal; the manager refuses any other `material.owner` | `the host enrolled the agent under owner <owner>, not the spawning owner <owner>` | §13.16 execution |
| D4 | Bound to account, instance, epoch and lifecycle | admission records the assignment's account, instance, lifecycle and revision and the gate's epoch; execution compares the request with the record, then requires the fresh assignment and gate to equal the record, before the CAS and again after it for a launch | another account, instance, lifecycle or revision, in the request or in the fresh assignment: `permission-denied`; a stale gate epoch: `conflict`; a move after the CAS: compensated at the pinned UID, then `outcome: "aborted"`, no row | §13.16 execution |
| D5 | One target | the record names one target; execution must name the same one; a retirement admission compares the launch record's target actor, never its admitting actor | a different target: `permission-denied`, before the CAS | §13.16 admission, execution |
| D6 | No replay, no standing right | single CAS from `admitted` to `consumed`; `expiresAt` at most 300 s; the holder gains no ledger row, scope or grant | consumed by another request, or expired: `failed-precondition`; a lost CAS: `conflict` | §13.16 execution |
| D7 | Retirement keeps #1972 | uid-exact prepare, known-handle provider closure, terminal barrier with the derived op id; host-run when the holder is gone | a non-delegated lifecycle, a launch with no `enrolled` outcome, or a foreign owner: refused at admission; an uncertain step keeps the alias held | §13.16 retirement |
| D8 | R8 and H13 unchanged | section 8 | H13's spawn and `authorizeAdmin` answers unchanged | §13.16 last paragraph |
| D9 | A crash or a lost answer strands nothing | the consuming CAS pins request id, epoch, lifecycle UID, digest or op id and the executor incarnation before any effect; one flight per intent runs the execution and every request equal to the pin joins it; only the executor advances a launch, and a sweeper takes only the terminal edge that retires the pinned UID; a launch activates its UID before any row or durable; every refusal after the CAS is compensated, never aborted directly; every compensation completes that activation before the barrier unless a retirement at that UID has begun, which it resumes | none for the pinned retry, which gets the flight's answer; a flight whose `outcome` CAS lost answers no material; `notStarted` is never terminal confirmation; the alias stays held until an outcome | §13.16 execution, recovery |
| D10 | A late executor cannot touch a successor | a consumed record holds its alias; after a sweeper's claim the hold outlives the outcome until the executor's own flight stops, revokes any grant at the pinned UID and sets `released`, or an operator releases it by hand | launch admission and the host's enrollment writer, for either door, refuse a held alias as `failed-precondition` with no write | §13.16 recovery |

## 10. Where it fails closed

| Site | Answer |
|---|---|
| a host that composes no intent route | the shipped doors refuse any principal other than the user (section 1); no door accepts an owner or intent field |
| stock `dispatchManagerAuthorityRequest` | `unimplemented` for `delegated-user-intent` and `manager-delegated-user-intent-execution` |
| the platform-control door | `bad-request` for the execution kind (unknown kind) |
| a host without an assignment observer or intent store | both requests `unimplemented` |
| an observer, ledger or record read error | `unavailable`, never a cached answer |
| a manager with `delegatedIntent` and no `executeDelegatedUserIntent` | the spawn is refused before any request and writes nothing |
| a delegated slot's stop, exit, reap or rollback | the name stays held and the holder calls none of its own retirement callbacks; only `retireDelegatedAgent` with `retired: true` frees it |
| a consumed record with no `outcome` | the alias stays held, no new request is admitted on the record, the executor resumes it, and any other incarnation only claims it and compensates at the pinned UID; a retry that finds neither is `unavailable` |
| a compensation whose activation is refused because the alias is `active` or `retiring` at another UID | no `outcome`, the alias stays held, and the compensator retries at its next scan; nothing exists at the never-activated UID |
| a managed retire door answering `notStarted` to a compensation | not terminal: the order starts again from the prepare |
| a compensation that finds the head `retiring` or `retired`, or the gate `frozen` or `retired` by the derived op id, at the pinned UID | no activation; the managed retire door resumes that op from its durable intent |
| a refusal after the consuming CAS on any flight, the first included | compensation at the pinned UID before `aborted`; the alias stays held until then |
| a record a sweeper claimed and the executor has not `released` | the alias stays held after the outcome; launch admission and the enrollment writer refuse it; only the executor's flight or an operator by hand releases it |

## 11. Symbol status

| Symbol | Package | Status at this head |
|---|---|---|
| `DelegatedUserLaunchTarget`, `DelegatedUserIntentOperation`, `DelegatedUserIntentRequest`, `DelegatedUserIntentAdmission`, `DELEGATED_USER_INTENT_MAX_TTL_SECONDS` | `@cotal-ai/core` | shipped |
| `RemoteDelegatedUserIntentExecutionRequest`, `RemoteDelegatedUserIntentExecutionResult`, `parseDelegatedUserIntentRequest`, `parseRemoteDelegatedUserIntentExecutionRequest` | `@cotal-ai/core` | shipped |
| `parseRemoteDelegatedUserIntentExecutionResult`, `resolveReadAcl` | `@cotal-ai/core` | shipped |
| `DelegatedUserIntentRecord`, `DelegatedUserIntentExecutionPin`, `DelegatedUserIntentIncarnation`, `DelegatedUserIntentFlights`, `joinOrStartDelegatedUserIntent`, `delegatedUserIntentHoldsAlias`, `ObservePlatformControlAssignment`, `authorizeDelegatedUserIntentAdmission`, `authorizeDelegatedUserIntentExecution`, `DelegatedUserIntentDecision` | `@cotal-ai/auth` | shipped; stock dispatch refuses both kinds as `unimplemented` |
| `AuthServiceHandle.observeManagerGate`, `AuthServiceHandle.activateManagedLifecycle` | `@cotal-ai/auth` | shipped; present with `platformControl` |
| `AuthServiceHandle.registerHostIncarnation`, `AuthServiceHandle.observeHostGate`, `AuthServiceHandle.awaitHostFence`, `PlatformControlInput.host` | `@cotal-ai/auth` | shipped; present with `platformControl.host`; the host registers its persisted instance id at every start and arms `awaitHostFence` with the returned incarnation, before it admits or recovers a flight; the return is a committed coordinate, `observeHostGate` a point-in-time read, and the hook resolves once a later registration or barrier fences that incarnation |
| `remoteAuthority.executeDelegatedUserIntent`, `StartAgentOpts.delegatedIntent`, `Manager.retireDelegatedAgent` | `@cotal-ai/manager` | shipped |
| `PlatformControlAssignment`, `platformControlOwner`, the `p_` grammar, the platform control door | `@cotal-ai/auth`, `@cotal-ai/core` | absent at this branch's base; shipped on main at `6ca4d8e0f` (#2408) |
| `grantManagedActor`, `assertWithinSpawnerGrant` (module-private in `ledger.ts`; the admission decision calls it from inside `@cotal-ai/auth`), `provisionAgentDurables`, `remoteManagerCurrentRegistrationProof`, `managedRetirementOpId`, the managed retire flight | auth, core | shipped, reused unchanged; a hosted host reaches the flight at `POST /managed-lifecycle/retire` with the handle's `cap` |
| `activateLifecycleAtUid` | `@cotal-ai/auth` | shipped and package-internal; a host reaches it only through the handle's `activateManagedLifecycle` |

The platform control door landed on main at `6ca4d8e0f`. Its assignment observer is keyed by space
and account, where the platform-control record at `2392055` keyed it by instance, so section 4.2 and
both step 4 reads follow the shipped signature and require the account's one current assignment to
name the intent's instance. `ObservePlatformControlAssignment` is that door's observer type, and the
decisions read the holder's owner and gate as the door does. `assertWithinSpawnerGrant` is now a
module export of `ledger.ts` so the admission decision can run its dry walk. It is not re-exported
from the package. The manager's launch and retirement paths only carry the host's answers: the
decisions are the authority. `resolveReadAcl` is the read-list resolution `provisionAgentDurables`
already ran inline, exported so the admission's dry walk and the writer resolve the same list.

## 12. Native acceptance

Hand tests an operator runs against a real broker, a hosted authority context with the
platform-control door, the platform's own route for the holder, its Runtime, and one signed-in user
`U` with `spawn` on actor `cli`. They are not smoke suites. A host passes when every row matches.

| # | Do | Expect |
|---|---|---|
| A1 | As `U`, admit a launch of `w1` on the holder's instance, then have the holder start `w1` with that intent | the roster card, the ledger row and the bearer's owner are `U`'s `u_`; the row's `parent` is `<u_>.cli` |
| A2 | On the same space, sign in as `U`, run `U`'s own `cotal supervise` manager and spawn `w2` with the same target from `cli`; compare the host's ledger rows for `w1` and `w2` | equal in owner, parent, scope, read, post, role, label and membership; only `lifecycleUid`, `tokenHash` and `grantedAt` differ |
| A3 | Admit with read or post wider than `U`'s `cli` row | refused with the envelope walk's sentence; no record |
| A4 | Present one admitted intent from another instance, with another `managerLifecycleUid`, with a different target actor, then restart the holder and present it both with the old epoch and from the restarted holder | `permission-denied`, `permission-denied`, `permission-denied`, then `conflict` (stale gate epoch) and `permission-denied` (epoch not the record's); auth KV and the intent store unchanged; no ledger row |
| A5 | Present a consumed intent with another `requestId`, and again with its `requestId` and another token digest; present an admitted intent past `expiresAt` | `failed-precondition` for all three; no enrollment. The identical request is a retry of the consumed execution and is covered by A15 to A17 |
| A6 | Have the holder execute with an intent id `U` never admitted, and admit with no IdP token or with a token the IdP did not sign | refused; no record and no row |
| A7 | As a `u_` principal, ask the platform manager to spawn, and ask `authorizeAdmin` (H13) | spawn refused on owner mismatch; `authorized: false` |
| A8 | Have the holder call `prepareAgentRetirement` and `validateRetainedAgent` for `w1` | refused on owner mismatch; `w1` keeps running |
| A9 | As `U`, admit a retirement of `w1`, then have the holder execute it | grant revoked at `w1`'s UID, runtime record `closed`, the lifecycle head `retired` at that UID, alias free; `retired: true` |
| A10 | Launch `w3`, stop the holder and revoke its assignment, then admit a retirement of `w3` | the host runs it with no holder; the same end state as A9; a `POST /managed-lifecycle/retire` for that UID afterwards answers `alreadyRetired: true` |
| A11 | Admit a retirement of an agent `U`'s own manager launched, and of another owner's agent | `failed-precondition` and `permission-denied`; nothing revoked |
| A12 | Send either request with an extra field (`owner`, `idpToken`, `scope`, `supervise`) and send the execution kind inside a platform-control envelope | `bad-request` for all; no effect |
| A13 | Admit a launch, have the backend advance the instance's assignment revision with its gate left open, then have the holder present the intent | `permission-denied`; the record stays `admitted`; no row |
| A14 | Admit a launch, hold the host between the CAS and step 7's second read (a debugger breakpoint), advance the assignment revision, then release it | `permission-denied`; the head and gate at the pinned UID are `retired`; the record is `consumed` with `outcome: "aborted"`; no row |
| A15 | Admit a launch and stop the host after the ledger write, before `outcome` is set and before any bearer exchange for `w1` (a breakpoint, then kill). Before restarting, read the lifecycle head and issuance gate at the pinned UID. Restart it, have the holder resend the same request, then admit a retirement of `w1`, a new launch of `w1` and a launch of `w1b` | before the restart the head is `active` and the gate `open` at the pinned UID; the restarted host is a sweeper: `sweptBy` is its incarnation, the grant at the pinned UID is revoked, the managed retire door answers `retired: true` (never `notStarted`), that lifecycle head and its gate are `retired`, and the record is `aborted` with no `released`; the resend answers `failed-precondition` and the manager frees its slot; the retirement admission and the new `w1` launch admission are `failed-precondition`; `w1b` is admitted |
| A16 | Execute an admitted retirement, drop its answer before the holder reads it, and resend the same request | the resend answers from the same flight with the same op id; one terminal barrier; `retired: true` |
| A17 | Admit a launch, hold its flight after step 7's second read and before the ledger write, have the holder resend the same request, advance the assignment revision, then release the flight | the resend joins the flight and answers the same material as the first request; one row at the pinned UID; `outcome: "enrolled"`; no terminal barrier at that UID; a new admission on the old revision is refused |
| A18 | Admit a launch, hold its flight after the ledger write and before the durables, have the holder resend the same request, narrow `U`'s `cli` row below `w1`'s lists, then release the flight | the resend joins and answers the same material; `outcome: "enrolled"`; no terminal barrier at the pinned UID; `w1`'s next bearer exchange is refused by the envelope walk |
| A19 | Admit a launch, hold its flight after the ledger write, start a second host process on the same instance (its restart advances the process epoch) while the first stays held, send it the same request, then release the first | the second process claims `sweptBy`, retires the pinned UID and ends the record `aborted`; its answer is `failed-precondition`; the released flight finds `sweptBy` or loses its `outcome` CAS, revokes any row it wrote at the pinned UID, sets `released`, and answers `failed-precondition` from the record's `aborted` outcome; no credential mints at the pinned UID |
| A20 | Admit a launch and stop the host after the consuming CAS and before step 8's activation (a breakpoint, then kill). Read the head and gate at the pinned UID, then restart it | before the restart there is no gate at the pinned UID and no row; the sweeper activates that UID, the managed retire door answers `retired: true`, the head and gate are `retired` there, and the record is `aborted`; no row exists at any point |
| A21 | Admit a launch and stop the host inside step 8's activation, after the gate at the pinned UID is created `frozen` and before the head CAS (a breakpoint, then kill). Restart it | the sweeper's activation adopts that frozen gate and completes it, then the end state of A20 |
| A22 | Admit a launch of `w4` while `U`'s own manager has `w4` running, so the head is `active` at another UID, and stop the host after the consuming CAS (a breakpoint, then kill). Restart it, then retire `U`'s own `w4` | while that `w4` runs, the sweeper's activation is refused, the record keeps no `outcome`, no row or gate exists at the pinned UID, and a new `w4` launch admission is `failed-precondition`; after the retirement the next scan activates and retires the pinned UID and ends the record `aborted` |
| A24 | Admit a launch of `w5` and make its durable provisioning throw `unavailable` once, after the ledger write (a breakpoint that throws). Keep the host running, advance the assignment revision, then have the holder resend the same request | the resend joins a new flight that resumes at step 7 and is refused there; that flight revokes the grant at the pinned UID, the managed retire door answers `retired: true`, the head and gate are `retired` there, the record is `aborted` with no `released`, the alias is free, and the resend answers `permission-denied` |
| A25 | Run A24, and in its compensation make the head's `active` to `retiring` write throw `unavailable` once, right after the barrier froze the gate (a breakpoint that throws). Keep the host running and let its next scan retry | before the retry the head is `active` and the gate `frozen` by `managedRetirementOpId` at the pinned UID; the retry does not activate, the managed retire door resumes that op from its intent and answers `retired: true`, and the end state is A24's |
| A23 | Run A19, and while the first process is still held, as `U` admit a new launch of `w1`, and have `U`'s own remote manager enroll `w1`; then release the first process, and launch `w1` again | while the first process is held both are `failed-precondition` with no row written; after its release sets `released`, the new launch is admitted and `enrolled` at a fresh UID, the ledger row for `w1` is at that UID, and it stays there: the first process writes nothing more |

## 13. Residual risk

The holder generates and keeps the agent's actor token, as the user's own remote manager does. A
compromised holder can act as that agent within the agent's own attenuated grant until retirement or
until the user narrows `cli`, which bites at the next bearer. It cannot widen the grant, launch
another agent, or reuse the intent.

The host is the only writer of the intent store, and its create and CAS are the replay fence. A host
that skips the CAS would let one intent run twice. The acceptance rows A4 and A5 exist to catch that.

A sweeper decides that an executor is gone from the executor instance's issuance gate. An executor
process that dies while its gate stays `open` at the pinned epoch is not swept: the record keeps no
`outcome` and the alias stays held until that instance restarts or its gate leaves `open`. A sweeper
that is wrong costs the launch, never authority. A row the executor writes at the pinned UID after
a sweeper's prepare mints nothing, because the issuance gate at that UID is retired, and the
executor's own flight revokes it before it sets `released`.

A swept alias stays held until the executor's flight releases it. An executor killed after the
sweep never does, so its alias stays unusable until an operator confirms the process exited and
releases it by hand. That is the cost of not inferring a dead incarnation from a restart, the same
cost §13.7 accepts for a `draining` name. The user can launch under another name meanwhile.

A compensation whose activation is refused because the alias is live at another UID waits for that
incarnation to retire. Until then the record has no `outcome` and the alias stays held, which costs
nothing new, because that live incarnation already occupies the alias.

Two enrollments of one alias that run at once, each reading the hold before the other's consuming
CAS, still race on the owner-and-actor upsert, as two enrollments of one alias race today, and the
alias head admits one incarnation. The hold does not change that race. It keeps a swept executor
off the alias after the sweep.
