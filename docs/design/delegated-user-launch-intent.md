# Delegated user launch intent

Status: proposed contract. Nothing here is implemented or released. This change adds the design, an
insertion-only SPEC §13.16 and one paragraph of the embedding guide. It adds no runtime path, no
route, no record store and no exported type. None of the symbols in section 4 exists in source or in
a built declaration at this head. Section 11 lists each symbol's status and why it waits.

The source inventory below was checked at `d00f18cd62f5933c7dceb93b56559498b66656bc` (v0.58.0 plus
later fixes on main). The platform holder this record extends is the `p_` holder of
[platform-pooled-control-authority.md](platform-pooled-control-authority.md) as it reads at commit
`2392055fef5777a4c1c8bcbac6621aefd9e9705e`. That record is referenced here and not edited. Its R8
and H13 rows read the same at the later `1e32152050fb83cf6d0c2c04f1564b5183d558a4`.

The question is how a platform control holder can run one launch or one retirement that a real,
signed-in user asked for, so that the intent and the resulting agent stay the user's. The answer is
one user-authored intent record, admitted on the host's existing authenticated human route, and one
holder-side execution request that consumes it once. The host then runs the writers it already runs
for a user's own remote manager, with the user's owner and the user's spawning principal. The holder
contributes a runtime and a registration. It contributes no authority.

## 1. What a user-initiated launch does today

Two arms in `Manager.provisionUserAgent` (`implementations/manager/src/manager.ts`) decide every
user-mode spawn. The line numbers are this head's. The same statements stand at the v0.58.0 tag
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
closed and has no owner or intent field. The `p_` holder does not exist at this head.

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

Written here so a producer can adapt against them. They land in the implementation round
(section 11).

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
  actor: string;
  requestId: string;
  /** Host-generated, 26 base32-lower characters of fresh entropy. Never caller-selected. */
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
 * then one revision-pinned CAS from `admitted` to `consumed` before any effect. */
export interface DelegatedUserIntentRecord extends Omit<DelegatedUserIntentAdmission, "v" | "kind" | "requestId"> {
  v: 1;
  /** `<owner>.<actor>`: the launched agent's ledger parent, and the principal the envelope walk starts from. */
  parent: string;
  state: "admitted" | "consumed";
  /** Launch only, set by the host's enrollment writer after consumption. A later retire intent may
   * name only a lifecycle a consumed launch record carries. */
  lifecycleUid?: string;
}

/** The platform-control record's assignment observer, unchanged. */
export type ObservePlatformControlAssignment = (space: string, instanceId: string) => Promise<PlatformControlAssignment | null>;

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
  /** The host's consumed launch record for (owner, target.actor, target.lifecycleUid), read fresh. Retire only. */
  observeLaunchRecord(owner: string, actor: string, lifecycleUid: string): Promise<DelegatedUserIntentRecord | null>;
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
  owner: string;
  parent: string;
  instanceId: string;
  operation: "launch" | "retire";
  target: DelegatedUserLaunchTarget | RemoteManagedAgentPrepareRetirementRequest["target"];
  /** Launch only. */
  tokenHash?: string;
  /** Retire only: managedRetirementOpId(target.lifecycleUid). */
  opId?: string;
}

/** Decides one execution. Writes nothing; the host consumes the record before acting on the decision. */
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
/** Retire one agent this manager launched under a delegated intent, through the host. Frees the
 * slot only on `retired: true`; any other answer keeps the alias held. */
retireDelegatedAgent(name: string, intentId: string): Promise<ControlReply>;
```

With `delegatedIntent` set, `provisionUserAgent` takes the hosted arm with
`executeDelegatedUserIntent` in place of `enrollManagedAgent`. It sends
`{ intentId, operation: "launch", target: { actor: name, tokenHash } }` and binds the answer with the
existing checks: `material.actor` must equal `name`, and the spawning owner is
`delegatedIntent.owner`, so the existing `the host enrolled the agent under owner <owner>, not the
spawning owner <owner>` sentence refuses any other owner. The spawn record stores
`userOwner: material.owner` and `spawner: delegatedIntent.parent`.

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
4. Launch: `observeAssignment(space, instanceId)` is read fresh. It must exist, be `assigned` and
   name this account. `observeManagerGate(instanceId)` must be open with principal
   `<platformOwner>.manager_serve_<instanceId>`. The host records the assignment's `lifecycleUid`
   and revision and the gate's process epoch. A missing, revoked or foreign assignment, or a gate
   that names another principal, is `permission-denied`. A gate that is not open is
   `failed-precondition`. An observer error is `unavailable`.
5. Launch: the target's scope, lists and role must pass `assertWithinSpawnerGrant` as a dry check
   against the parent `<owner>.<actor>`, refused with the walk's own sentence. The authoritative
   walk and the writer's other refusals, such as an interactive row of the same name, run again at
   the write (section 6).
6. Retire: `target.owner` must equal the owner (`permission-denied`). `observeLaunchRecord` must return a consumed launch
   record of this owner whose `lifecycleUid` equals `target.lifecycleUid`, whose actor equals
   `target.actor` and whose `instanceId` equals the request's. A lifecycle the user's own manager
   launched is retired through that manager's path and is refused here as `failed-precondition`.
   The host then reads the assignment and gate as in step 4. When the launching holder is present
   (section 7.2 defines gone), the record binds its current coordinates. When it is gone, the record
   binds the launch record's `managerLifecycleUid` and `assignmentRevision` with `serveEpoch: null`.
7. The host generates `intentId`, sets `expiresAt` to at most
   `DELEGATED_USER_INTENT_MAX_TTL_SECONDS` ahead, and creates the record with `state: "admitted"`.
   A create that loses is refused.

## 6. Launch execution

The holder posts `RemoteDelegatedUserIntentExecutionRequest` on the platform's route for the holder.
The platform-control door refuses this kind as an unknown kind (`bad-request`), so its closed union
stays as written. One execution runs in this order, and every refusal writes nothing:

1. The request is closed and its `actor` is the literal `"cli"`. `space` and `accountPublicKey` must
   equal the context's.
2. The record for `intentId` is read fresh. Absent, `consumed` or past `expiresAt` is
   `failed-precondition`.
3. `instanceId`, `managerLifecycleUid`, `assignmentRevision` and the operation must equal the
   record's. Any difference is `permission-denied`.
4. The assignment is read fresh as in admission step 4. The gate must be open with principal
   `<platformOwner>.manager_serve_<instanceId>`. A gate epoch different from the request's
   `serveEpoch` is `conflict`. A request epoch different from the record's `serveEpoch` is
   `permission-denied`. The registration proof must match
   `remoteManagerCurrentRegistrationProof(proofSecret, platformOwner, request, gate)`.
5. `execute.target.actor` must equal the record's target actor. A different target is
   `permission-denied`.
6. The host CASes the record from `admitted` to `consumed` at the revision step 2 read. A lost CAS
   is `conflict` and nothing is enrolled.
7. The host runs the enrollment writer it already runs for `manager-managed-agent-enrollment`, with
   the decision's values. It selects the lifecycle UID, writes the ledger row through
   `grantManagedActor`, provisions the lifecycle-keyed durables and returns the hosted enrollment
   material. It records the UID on the consumed record. The host MUST use that one writer for both
   doors, so a delegated row and a row from the user's own remote manager cannot diverge.

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

Every field except the last row is equal for equal inputs. The holder is not on the agent's
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
4. free the alias and the hosted survivor record only after terminal confirmation.

A failed or uncertain step keeps the alias held. A retry is the same operation on the same UID,
because the operation id is derived and the flight is shared.

### 7.1 Holder present

The holder sends the execution request with `execute: { operation: "retire", target }`. Steps 1 to 6
of section 6 apply, with step 5 comparing the full `{ owner, actor, lifecycleUid }`. After the CAS
the host runs the order above and answers `retired`. `Manager.retireDelegatedAgent` frees the slot
only on `retired: true`. It never calls `prepareAgentRetirement` or `mintRetirementRequester` for a
delegated agent: those bind to the holder's `p_` owner and would be refused for a `u_` target.

### 7.2 Holder gone

The launching holder is gone when its assignment is absent, `revoked` or at another revision, or its
gate is not open, or the gate's epoch differs from the launch record's. A retirement admitted then is
bound to the launching instance with `serveEpoch: null`. No holder can present it, because execution
step 4 requires a current epoch equal to the record's. The host consumes it itself, with the
admission decision as its only authorization and no execution request, and runs the same
order to the same barrier. A retirement bound to a holder that is gone before it executes expires
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
| D4 | Bound to account, instance, epoch and lifecycle | admission records the assignment's account, instance, lifecycle and revision and the gate's epoch; execution re-reads all of them and the registration proof | another account, instance, lifecycle or revision: `permission-denied`; a stale gate epoch: `conflict` | §13.16 execution |
| D5 | One target | the record names one target; execution must name the same one | a different target: `permission-denied`, before the CAS | §13.16 execution |
| D6 | No replay, no standing right | single CAS from `admitted` to `consumed`; `expiresAt` at most 300 s; the holder gains no ledger row, scope or grant | consumed or expired: `failed-precondition`; a lost CAS: `conflict` | §13.16 execution |
| D7 | Retirement keeps #1972 | uid-exact prepare, known-handle provider closure, terminal barrier with the derived op id; host-run when the holder is gone | a non-delegated lifecycle or a foreign owner: refused at admission; an uncertain step keeps the alias held | §13.16 retirement |
| D8 | R8 and H13 unchanged | section 8 | H13's spawn and `authorizeAdmin` answers unchanged | §13.16 last paragraph |

## 10. Where it fails closed

| Site | Answer |
|---|---|
| Today, every site: none of these symbols exists | the shipped doors refuse any principal other than the user (section 1); no door accepts an owner or intent field |
| stock `dispatchManagerAuthorityRequest` | `unimplemented` for `delegated-user-intent` and `manager-delegated-user-intent-execution` |
| the platform-control door | `bad-request` for the execution kind (unknown kind) |
| a host without an assignment observer or intent store | both requests `unimplemented` |
| an observer, ledger or record read error | `unavailable`, never a cached answer |
| a manager with `delegatedIntent` and no `executeDelegatedUserIntent` | the spawn is refused before any request and writes nothing |
| a design reviewers reject | nothing lands: the declarations stay in this record (section 11) |

## 11. Why the declarations wait

| Symbol | Package | Status at this head |
|---|---|---|
| `DelegatedUserLaunchTarget`, `DelegatedUserIntentOperation`, `DelegatedUserIntentRequest`, `DelegatedUserIntentAdmission`, `DELEGATED_USER_INTENT_MAX_TTL_SECONDS` | `@cotal-ai/core` | proposed, absent |
| `RemoteDelegatedUserIntentExecutionRequest`, `RemoteDelegatedUserIntentExecutionResult` and the three parsers | `@cotal-ai/core` | proposed, absent |
| `DelegatedUserIntentRecord`, `ObservePlatformControlAssignment`, `authorizeDelegatedUserIntentAdmission`, `authorizeDelegatedUserIntentExecution`, `DelegatedUserIntentDecision` | `@cotal-ai/auth` | proposed, absent |
| `remoteAuthority.executeDelegatedUserIntent`, `StartAgentOpts.delegatedIntent`, `Manager.retireDelegatedAgent` | `@cotal-ai/manager` | proposed, absent |
| `PlatformControlAssignment`, `platformControlOwner`, the `p_` grammar | `@cotal-ai/auth`, `@cotal-ai/core` | proposed by the platform-control record, absent |
| `grantManagedActor`, `assertWithinSpawnerGrant` (module-private in `ledger.ts`; the admission decision calls it from inside `@cotal-ai/auth`), `provisionAgentDurables`, `remoteManagerCurrentRegistrationProof`, `managedRetirementOpId`, the managed retire flight | auth, core | shipped, reused unchanged |

They land after the platform-control implementation is on main, because the holder, its owner
grammar and its assignment observer are inputs to both decisions. A decision type with no producer
would advertise authority no host provides.

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
| A5 | Present a consumed intent, and one past `expiresAt` | `failed-precondition` for both; no enrollment |
| A6 | Have the holder execute with an intent id `U` never admitted, and admit with no IdP token or with a token the IdP did not sign | refused; no record and no row |
| A7 | As a `u_` principal, ask the platform manager to spawn, and ask `authorizeAdmin` (H13) | spawn refused on owner mismatch; `authorized: false` |
| A8 | Have the holder call `prepareAgentRetirement` and `validateRetainedAgent` for `w1` | refused on owner mismatch; `w1` keeps running |
| A9 | As `U`, admit a retirement of `w1`, then have the holder execute it | grant revoked at `w1`'s UID, runtime record `closed`, the lifecycle head `retired` at that UID, alias free; `retired: true` |
| A10 | Launch `w3`, stop the holder and revoke its assignment, then admit a retirement of `w3` | the host runs it with no holder; the same end state as A9; a `POST /managed-lifecycle/retire` for that UID afterwards answers `alreadyRetired: true` |
| A11 | Admit a retirement of an agent `U`'s own manager launched, and of another owner's agent | `failed-precondition` and `permission-denied`; nothing revoked |
| A12 | Send either request with an extra field (`owner`, `idpToken`, `scope`, `supervise`) and send the execution kind inside a platform-control envelope | `bad-request` for all; no effect |

## 13. Residual risk

The holder generates and keeps the agent's actor token, as the user's own remote manager does. A
compromised holder can act as that agent within the agent's own attenuated grant until retirement or
until the user narrows `cli`, which bites at the next bearer. It cannot widen the grant, launch
another agent, or reuse the intent.

The host is the only writer of the intent store, and its create and CAS are the replay fence. A host
that skips the CAS would let one intent run twice. The acceptance rows A4 and A5 exist to catch that.
