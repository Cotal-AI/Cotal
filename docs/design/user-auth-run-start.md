# User-auth run start

Status: implemented for issue #1956. Section 4 names the shipped symbols, with these differences:

- `issuedUserCaller` is exported by `@cotal-ai/core` (`issued-authority.ts`), because the connector's
  manager calls open the same view and cannot import `@cotal-ai/workspace`. The connector reads the
  row on every view; a managed row's view holds no read grant, so the broker refuses the read and the
  call keeps the legacy rail.
- The `issuer` profile gains the per-key `DIRECT.GET` read of the accepted store, so the callout can
  find the row a reconnect's nonce names.
- The issuing host checks an answering operator's pause before its caller, then refuses one with no
  `served` as `permission-denied`, so the closed parser still accepts `operator.answers` alone.
- An amendment's operator request carries `answers.amend: true`. The issuing host then requires the
  pause settled `resumed` naming an accepted answer, where an answer requires it waiting.
- Not delivered: section 9 item 3. A run that spawns and turns an owned agent and receives a typed
  answer from it on a user-auth space is not supported by this change, so issue #1956 stays open for
  that part.
- A participant manager forwards a legacy-rail answer, and the issuing host refuses it unless it
  comes from a live managed seat of the run's owner. A legacy-rail resume is refused on the manager.
- `AclResolver`'s `kind` is optional, so a resolver that does not set it never issues.
- `cotal run answer` rides the `self` target, so the forwarded subject keeps it and
  `authorizeServedRunCaller` accepts an untargeted or self-targeted subject.
- The issuing host subscribes read-only to the resume and answer request subjects
  (`servedRunRequestSubjects` in `authority-client.ts`), and `authorizeServedRunCaller` takes the one
  observation of the served subject through a new `takeObserved` input before it checks the caller.
  A forward the host did not observe, or already issued for, is refused. The observation keeps what
  the request's envelope asked for (`observedRunRequest` in `manager-authority.ts`), and a forward
  naming another run for a resume, or another endpoint or amendment for an answer, is refused.

The source inventory was checked at `6ca4d8e0f48d711769ea2e3710338e1e23dab82f`. Line numbers are that
head's.

The question is the smallest path by which a user who signed in with `cotal login --idp` can run
`cotal run start` on a user-auth space, have the run admitted on the versioned rail under authority
the host issued to that login, and keep the run theirs through answers and restarts. The host is the
signerless participant manager that stock `cotal supervise` composes. The answer is three changes.
The auth callout issues the `manager-caller` view connection that `cotal run` already opens for a
user as a §13.15 issuance, against a new source shape, the user's actor-ledger row. The CLI reads the generation back from its accepted row and calls
on `ep.v1`. The issuing host binds a participant manager's runs to the manager's registered owner,
and checks the served caller on every resume and principal answer. The run-hosting machinery the
participant manager already has (admission, attempts, renewal, operator credentials) is reused
unchanged.

## 1. What happens today

The refusal was reproduced at `3b616a239` through shipped entrypoints: a user-auth host with no
manager of its own, a participant registered with `cotal meshes add --mode user`, stock
`cotal supervise` activating a signerless remote manager, and the logged-in user running
`cotal run start --file <program>`. `cotal run ps` as the same user succeeds. `run start` exits 1 with:

```text
run-start binds a run to the caller's issued authority, and this request rode the legacy rail with none; re-mint the credential as an issuance and call on the versioned rail (SPEC 13.15, 14.8)
```

The same binary and program on a static-auth mesh start, answer a checkpoint and complete. Main moved
four commits since `3b616a239`, adding the platform control door. They change
`manager-authority.ts` and `service.ts` around the holder type and leave `run-hosting.ts`,
`manager.ts`, `connect.ts` and `permissions.ts` untouched, so the refusal path is the same. Every
site below is read at the current head.

| Site | What it does |
|---|---|
| `implementations/manager/src/run-hosting.ts:236-241` | `RunHosting.admit` refuses any `run-start` whose subject is not `ep.v1` with an issued caller, before either arm. This is the refusal above. |
| `implementations/manager/src/run-hosting.ts:242,264-277` | The signerless arm forwards the served subject through `RunHostingContext.admitRun` and checks the answer names the same run, endpoint, instance and caller. |
| `implementations/auth/src/manager-authority.ts:338-390` | `admitRemoteRun` on the issuing host authenticates the registered manager, re-parses the subject, resolves the caller's issuance and requires its publish ceiling to permit the subject. It never compares the caller's owner with the manager's registered owner. |
| `implementations/auth/src/service.ts:1106-1140` | `admitManagerRun` passes `session.sourceIsLive`, which is core's. |
| `packages/core/src/issuer-session.ts:44-58` | Core's `sourceIsLive` attests one source shape, `cred.<uid>` on `cotal_auth_<space>`, and refuses every other coordinate. |
| `implementations/runtime/src/run-command.ts:647-654` | Every `cotal run` verb resolves its target with the `control-caller-privileged` profile. |
| `packages/workspace/src/control-target.ts:101-111` | On a user mesh that profile becomes a `manager-caller` view bearer for the `cli` actor, pinned to one manager instance, and `epCaller` is `{ owner, actor, uid }` with no generation, so every user run request rides the legacy rail. `userConnectOrThrow` (`connect.ts:543-576`) builds the plain connection the same way. |
| `implementations/auth/src/permissions.ts:122-131` | The callout's `manager-caller` arm runs `authorizeManagerCaller` and calls `permissionsFor("manager-caller", …)` without `issued`. |
| `packages/core/src/provision.ts:1060,1557-1581` | `ISSUABLE_PROFILES` excludes `manager-caller`, so `permissionsFor` refuses `issued` for it. `managerCallerPermissions` already builds its rows through `issuedCallerFor` (`:1572`), which pins a generation when one is given, but it adds no accepted-row read. |
| `implementations/auth/src/service.ts:586-600,660-664` | `authorizeManagerCaller` mints the view only for a registered manager whose serve gate belongs to the caller's owner, or for the host's own manager. |
| `packages/workspace/src/connect.ts:441` and `implementations/manager/src/manager.ts:5578` | The only issuances in the repo: static `DEV_OWNER` control instruments and static managed seats. |
| `implementations/manager/src/manager.ts:3239-3240` | The signer-holding host's own manager refuses user mode by name. That refusal stays. |
| `implementations/manager/src/manager.ts:3257-3268` | `authorizeRunAnswer` narrows a managed baseline seat to its pending relay. Any other caller holding `run` may answer any run's pause on that manager. |
| `implementations/manager/src/run-hosting.ts:317-360` | `resume` checks the admission and its revocation, never the caller. |
| `packages/core/src/remote-manager-authority.ts:775-790` | `RemoteRunAttemptRequest` carries no served subject, so the issuing host cannot see who asked for a resume or an answer. |

So the remote run arm is complete on the host side except for owner binding, and no user-auth caller
can reach it, because no user credential is an issuance.

## 2. Scope

In scope: issuing an interactive user's `manager-caller` view at the callout, the user actor-ledger source
shape, the CLI reading its generation, owner binding at admission and on resume and answer for a
participant manager, the refusals, and the SPEC clauses.

Out of scope:

- Issuing user-mode managed seats. A seat answers through its pending relay on the legacy rail, and
  the host checks that path separately (section 5, P4).
- `cotal run start --local` on a user-auth space. A user bearer holds no run rows, and this record
  adds none.
- Hosting user runs on the signer-holding host's own manager. The issue requires a remote manager,
  and `manager.ts:3239-3240` keeps refusing.
- A user-facing route that writes a run's revocation marker on a participant manager. Section 8 names
  it as a residual.
- Platform authority and lifecycle intent. [Platform control authority](platform-pooled-control-authority.md)
  (on main) and the portable lifecycle bootstrap and delegated user launch intent records (on their
  own branches) cover a `p_` holder and its launches. This path does not use or change them, and it
  admits no `p_` caller. Under the owner rule of section 4.6 a `p_` holder's manager admits no `u_`
  caller either; a user's launch through a platform is the delegated intent record's concern.

## 3. The path

1. `cotal login --idp` stores the IdP session, as today.
2. `cotal run start` exchanges the session for the `cli` actor's `manager-caller` view bearer, pinned
   to the participant manager's instance, and dials with the sentinel credentials and that bearer
   under a client-chosen inbox nonce `connId`, as today.
3. The callout validates the bearer, runs the connect gate, resolves the actor's ACL and runs
   `authorizeManagerCaller`, as today. When the row is an interactive row, the callout mints the
   `manager-caller` permission set with `issued` and issues it before it signs the JWT. It chooses the generation,
   stages the evidence with one source, the actor's ledger row, releases it and writes the accepted
   row under `connectionAcceptedToken(connId)`. On a reconnect under the same `connId` it renews the
   recorded generation instead, and only when the ceiling is byte-identical.
4. The CLI reads its accepted row over the per-key `DIRECT.GET` grant its ceiling carries, refuses a
   row that names another owner, actor or lifecycle, and sends `run-start` on `ep.v1` with the
   generation pinned.
5. The participant manager's `RunHosting.admit` passes the rail check and forwards the subject through
   `admitRun`. The issuing host's `admitRemoteRun` authenticates the manager, requires the caller's
   owner to be the manager's registered owner, resolves the issuance with the composed source check,
   requires the ceiling to permit the subject, and writes the admission.
6. Attempts, renewal and operator credentials run as they do today. `authorizeRemoteRunAttempt`
   already pins the driver and mediator to `admission.caller.owner`, which step 5 made the registered
   owner.
7. `cotal run answer` and `cotal run resume` ride `ep.v1` the same way. The manager forwards the served
   subject with the attempt or operator request, and the host refuses another owner, a dead login and
   a ceiling that does not permit the subject.
8. A manager restart takes the run back through its boot reconcile. The attempt carries no served
   subject, and the host issues it under the original admission, as today.

## 4. Symbols

### 4.1 `@cotal-ai/core`, `packages/core/src/issued-authority.ts`

```ts
/** The accepted-row token of one user-auth connection: the first 32 hex characters of
 *  SHA-256("cotal.accepted.v1\0" + connId). The client chose `connId` and derives the token itself;
 *  the issuer never takes a token from a request body. Reconnecting under the same nonce names the
 *  same row, which is what makes a renewal findable. */
export function connectionAcceptedToken(connId: string): string;

/** The name the actor ledger carries as an issued source's bucket token: `cotal_actors_<space>`.
 *  It names the auth service's actor ledger. It is not a KV bucket and no client opens it. */
export function actorLedgerSourceBucket(space: string): string;

/** The source coordinate of one actor-ledger row:
 *  `{ space, bucket: actorLedgerSourceBucket(space), key: "actor.<owner>.<actor>.<lifecycleUid>" }`. */
export function actorLedgerSource(space: string, owner: string, actor: string, lifecycleUid: string): IssuedSourceRef;

/** The inverse of {@link actorLedgerSource}; `undefined` for any other coordinate. */
export function parseActorLedgerSource(source: IssuedSourceRef): { owner: string; actor: string; lifecycleUid: string } | undefined;
```

In `packages/core/src/provision.ts`, `ISSUABLE_PROFILES` (`:1060`) gains `"manager-caller"`, and
`managerCallerPermissions` adds the accepted-row read when it is issued:

```ts
const ISSUABLE_PROFILES: ReadonlySet<Profile> = new Set<Profile>(["agent", "control-caller-privileged", "control-caller-admin", "deployer", "manager-caller"]);
// managerCallerPermissions, pub.allow:
...(opts.issued ? [acceptedReadGrant(space, opts.issued.acceptedToken)] : []),
```

`IssuedSourceRef`, `IssuedEvidence`, `IssuedStore`, `readAcceptedRow` and `withIssuerSession` are
unchanged. Core's `sourceIsLive` keeps refusing the new shape, because only the auth service can read
the actor ledger.

### 4.2 `@cotal-ai/core`, `packages/core/src/remote-manager-authority.ts`

```ts
export interface RemoteRunAttemptRequest {
  // …every existing field unchanged
  attempt?: { runId: string; takeoverId: string; epoch: number; fencingToken: number; driverId: string; mediatorId: string;
    /** The served `run-resume` request subject, verbatim, when a caller asked for this attempt.
     *  Absent for a boot reconcile, which continues under the original admission. */
    served?: string };
  operator?: { id: string; takeoverId: string; runId?: string; answers?: { token: string; amend?: true };
    /** The served `run-answer` request subject, verbatim. Required with `answers`. */
    served?: string };
}
```

### 4.3 `@cotal-ai/auth`, `implementations/auth/src/ledger.ts`

```ts
/** Is an actor-ledger source live? True only when the ledger holds a row for the source's owner and
 *  actor, in either space (interactive or managed), whose `lifecycleUid` equals the source's.
 *  `revokeActor` deletes the row, and a re-grant that rotates the uid leaves a row with another uid,
 *  so both read as dead on the next resolution. */
export function ledgerActorSourceIsLive(dir: string): (source: IssuedSourceRef) => boolean;
```

`AclResolver` (`permissions.ts:26`) gains one field in its result, `kind: ActorKind`, which
`ledgerAclResolver` (`ledger.ts:503`) fills from `findActorUnified`.

### 4.4 `@cotal-ai/auth`, `implementations/auth/src/permissions.ts`

```ts
/** The callout's issuing seam for an interactive user's `manager-caller` view (SPEC 13.15). `mint`
 *  builds the view's permission set for the given `issued` pair, so the evidence is the set that is signed.
 *  Issues a fresh generation, or renews the generation the connection's accepted row already names. */
export type UserCallerIssuer = (args: {
  t: ValidatedUserToken;
  connId: string;
  mint: (issued: { generation: string; acceptedToken: string }) => Record<string, unknown>;
}) => Promise<Record<string, unknown>>;

export function calloutPermissions(
  resolveAcl: AclResolver,
  authorizeManagerCaller: (owner: string, instanceId: string) => Promise<void>,
  verifySession: SessionVerifier,
  issueUserCaller: UserCallerIssuer,
): (t: ValidatedUserToken, connId: string) => Record<string, unknown> | Promise<Record<string, unknown>>;
```

The `manager-caller` arm calls `issueUserCaller` after `authorizeManagerCaller` when
`acl.kind === "interactive"`. A managed row's `manager-caller` view, the `agent` arm and every other
view keep today's mint.

### 4.5 `@cotal-ai/auth`, `implementations/auth/src/service.ts`

`issueUserCaller` is composed beside `calloutPermissions` (`service.ts:1566`) over one
`withIssuerSession` window:

1. `token = connectionAcceptedToken(connId)`. Read the accepted row for `token` on the session's
   accepted KV.
2. No row: `generation = mintGeneration()`, `perms = mint({ generation, acceptedToken: token })`,
   `store.stage({ version: 1, ref, sources: [actorLedgerSource(space, owner, actor, uid)], permissions:
   importNativeSubjectPermissions(perms) })`, `store.release(prepared, async () => {})`, then
   `writeAcceptedRow(accepted, token, ref)`. Return `perms`.
3. A row naming this owner, actor and uid: `perms = mint({ generation: row.generation, acceptedToken:
   token })`, `store.confirm(ref, importNativeSubjectPermissions(perms))`, return `perms`.
4. A row naming anything else: refuse.

`admitManagerRun` (`service.ts:1106`) and `issueManagerRunAttempt` (`service.ts:1142`) pass one
composed check to the admission code:

```ts
const sourceIsLive = (source: IssuedSourceRef) =>
  parseActorLedgerSource(source) ? Promise.resolve(ledgerActorSourceIsLive(dir)(source)) : session.sourceIsLive(source);
const isLiveManagedActor = (owner: string, actor: string, lifecycleUid: string) => {
  const row = findActorUnified(dir, owner, actor);
  return row?.kind === "managed-agent" && row.lifecycleUid === lifecycleUid;
};
```

`issueManagerRunAttempt` does not open an issuer session today. It opens the same `withIssuerSession`
window `admitManagerRun` opens, only when the request carries `served`, and passes `session.store` as
`issued`. The issued-authority stores already exist on every space: `endpoint-binding.ts:367` creates
them with the endpoint stores.

### 4.6 `@cotal-ai/auth`, `implementations/auth/src/manager-authority.ts`

`admitRemoteRun` gains one check after it parses the subject:

```ts
if (isDerivedOwner(caller.owner) && caller.owner !== args.owner)
  throw new EpEnvelopeError("permission-denied", "a user's run is admitted only on the participant manager that user registered");
```

`isDerivedOwner` is a new predicate beside `assertDerivedOwnerToken` (`packages/core/src/subjects.ts:426`):

```ts
/** True when `owner` is a derived user owner (`u_` plus its grammar); the predicate form of
 *  {@link assertDerivedOwnerToken}, which throws on the same input. */
export function isDerivedOwner(owner: string): boolean;
```

A static caller whose credential was minted from the space signer, as
`remote-ef-continuity.smoke.ts` drives, keeps today's admission. So every user-admitted run on a
participant manager belongs to that manager's registered owner.

`authorizeRemoteRunAttempt` gains three inputs and one helper:

```ts
export async function authorizeRemoteRunAttempt(args: {
  // …every existing input unchanged
  issued: IssuedStore;
  sourceIsLive: (source: IssuedSourceRef) => Promise<boolean>;
  isLiveManagedActor: (owner: string, actor: string, lifecycleUid: string) => boolean;
}): Promise<RemoteRunAttemptGrant>;

/** The served caller of a resume or an answer, checked against the run's owner. */
async function authorizeServedRunCaller(args: {
  served: string;
  command: "run-resume" | "run-answer";
  /** The admission's owner for a resume; the manager's registered owner for an answer. */
  runOwner: string;
  space: string;
  endpoint: string;
  instanceId: string;
  issued: IssuedStore;
  sourceIsLive: (source: IssuedSourceRef) => Promise<boolean>;
  isLiveManagedActor: (owner: string, actor: string, lifecycleUid: string) => boolean;
}): Promise<void>;
```

`authorizeServedRunCaller` re-parses the subject as `admitRemoteRun` does (request plane, this space,
endpoint and instance, the named command, no target), then:

- requires `caller.owner === runOwner` when the caller's owner is a derived `u_` owner;
- on `ep.v1`, resolves the caller's issuance with `sourceIsLive` and requires its publish ceiling to
  permit the subject;
- on the legacy rail, accepts only `run-answer` from a caller whose row is a live managed row
  (`isLiveManagedActor`), which is the seat relay path, and refuses every other legacy caller.

An `attempt` with `served` runs it for `run-resume`, with `runOwner` set to
`admission.caller.owner`. An `operator` with `answers` must carry `served`, and the host runs it for
`run-answer` with `runOwner` set to the registered owner `args.owner`. The answering credential is
pinned to a checkpoint token, and the host cannot map a token to its run without replaying a journal.
It does not need to: after the admission check above, the registered owner is the only user owner of
any run on that manager, so no user can answer another user's pause there.

### 4.7 `@cotal-ai/manager`

```ts
// implementations/manager/src/run-hosting.ts, RunHostingContext
readonly issueAttempt?: (args: { runId: string; takeoverId: string; epoch: number; fencingToken: number;
  driver: Identity; mediator: Identity; served?: string }) => Promise<{ driver: string; mediator: string }>;
readonly issueOperator?: (args: { identity: Identity; takeoverId: string; runId?: string;
  answers?: { token: string; amend?: true }; served?: string }) => Promise<string>;

// RunHosting
async resume(args: { runId: string; timeout?: string }, served?: EpServeContext): Promise<{ runId: string }>;
async answer(args: { runId: string; endpoint?: string; stepKey: string; value?: unknown; artifact?: string },
  by: string, authorize?: (open: RunHostOpenPause) => void | Promise<void>, served?: EpServeContext): Promise<unknown>;
```

`RunHosting.amend` takes the same trailing `served?: EpServeContext`, because an amendment rides the
`run-answer` command and the same answering operator credential.

On a signerless host, `resume`, `answer` and `amend` rebuild the served subject from `served.subject`
the way `admitRemote` does (`run-hosting.ts:265-270`) and pass it through. A `run-resume` or principal
`run-answer` on the legacy rail is refused with the existing `EP_UNBOUND_CALLER_AUTHORITY` detail
before anything is forwarded. The boot reconcile calls `launch` with no `served`. The `runResume` and
`runAnswer` serve handlers (`manager.ts:3494-3499`) pass their `EpServeContext`. The callbacks at
`commands.ts:313-348` forward `served` into `remoteRunAttemptRequest`.

### 4.8 `@cotal-ai/workspace` and `@cotal-ai/cli`

```ts
// packages/workspace/src/connect.ts
/** Read this connection's accepted row (SPEC 13.15) and return the issued caller it names. Refuses a
 *  row whose owner, actor or uid is not `expected`'s; never trusts a generation from a file or a body. */
export async function issuedUserCaller(nc: NatsConnection, space: string, connId: string, expected: EpCaller): Promise<IssuedCaller>;
```

`askManagerEp` (`implementations/cli/src/lib/control.ts:92`) calls it on a user-mode `manager-caller`
connection (the target carries `managerInstanceId`) after it dials and before it builds a request
subject. A missing row is refused with the reason, never retried
on the legacy rail.

## 5. Required properties

| | Property | Mechanism | Refusal |
|---|---|---|---|
| P1 | The authority comes from the caller's real login. | Only the callout issues, and only for a `manager-caller` view bearer the auth service exchanged from a live IdP session for an interactive row the connect gate accepted (`ledgerAuthorizeConnect`), on an instance `authorizeManagerCaller` found to be that owner's. The generation is the issuer's. The evidence's single source is that row, by owner, actor and uid. | No session: `cotal login` refuses before any exchange. A managed row, the plain `agent` connection and every other view get no issuance and stay on the legacy rail, so `run-start` refuses as today. |
| P2 | No minted static credential and no legacy bypass. | The admission still resolves an issuance through `admitRemoteRun`; nothing adds a static `DEV_OWNER` credential or a signer on the participant. `RunHosting.admit` keeps its rail check. | A legacy `run-start` anywhere, and a legacy `run-resume` or principal `run-answer` on a participant manager, is `permission-denied` with `ai.cotal.ep.unbound-caller-authority`. A generation with no evidence, or a non-`active` one, refuses at resolution. |
| P3 | The run stays attributable to the user across answers and restart resume. | The admission's `caller` is the issued triple with its generation. The driver and mediator are pinned to `admission.caller.owner` (`manager-authority.ts:470`). An answer's `by` is the served caller's principal (`manager.ts:3247`), and the host checks that caller's owner. A reconcile resumes under the original admission. | A resume never re-admits (`run-hosting.ts:327-331`), so a resuming caller cannot change the owner or widen the ceiling. |
| P4 | A second user cannot start on, answer, resume or take over the run. | The issued connection cannot reach another owner's manager at all: `authorizeManagerCaller` refuses a `manager-caller` view for an instance whose serve gate is not the caller's owner's (`service.ts:594`). Behind that, start: `admitRemoteRun` requires the caller's owner to be the manager's registered owner. Resume: `authorizeServedRunCaller` requires the admission's owner. Answer and amend: it requires the registered owner, the only user owner a run on that manager can have. Takeover by another manager: `authorizeRemoteRunAttempt` already refuses an admission from another instance (`manager-authority.ts:458-459`). | `a participant manager admits runs only for its registered owner`; `run-resume and run-answer on this manager are open only to the owner its runs were admitted for`; the existing `run <runId> was admitted on another manager instance or endpoint`. |
| P5 | A revoked login cannot answer, resume or take over. | Revoking the actor row (`revokeActor`) or re-granting it under a new uid makes `ledgerActorSourceIsLive` false, so every issuance on that row stops resolving on the next request. The participant manager's own host calls run under the same owner's `cli` row: the host route re-reads it (`service.ts:1783`), and the provider fetches a fresh IdP token from the cached session for every call (`provider.ts:758`). So a revoked row, or an IdP session revoked at the IdP, also stops every admission, attempt, operator issuance and renewal the manager asks for, a boot reconcile included. | `generation <g> depends on cotal_actors_<space>/actor.<owner>.<actor>.<uid>, which is no longer live (SPEC 13.15)`, from `IssuedStore.resolve`; the host route's ledger refusal or the provider's IdP session refusal for the manager's own calls. |
| P6 | The host is the signerless participant manager composed by stock `cotal supervise`. | `commands.ts:313-348` already supplies the four closed callbacks, so `RunHosting` is remote. This record changes what the callbacks carry, not who supplies them. The signer-holding host's own manager keeps its user-mode refusal. | `user-auth space "<space>" hosts no workflow runs yet: …` from `manager.ts:3240`, unchanged. |

## 6. What SPEC requires today and what is inserted

§13.15 today: a hosted effect under an issued authority needs a generation that the issuer chose and
the broker confined to the `ep.v1` rail, and evidence persisted before the material is returned. A
client learns its generation only from its accepted row. Resolution needs every source live, and the
one source shape the revision issues against is a static incarnation's `cred.<lifecycleUid>`. A
command that needs the binding (`run-start`) refuses the legacy rail.

§14.8 today: before the driver launches, the hosting endpoint writes the admission with the caller's
resolved ceiling and an `issued` provenance. A resume, takeover or reconcile continues under the
original admission and does not consult the resuming caller's authority. §14.1 already requires a
user-auth run's durable actions to use the owner its authenticated admission established.

Neither section says who may issue a user-auth connection, what source a user issuance depends on,
whose runs a participant manager hosts, or who may resume or answer a user's run. SPEC.md gains two
paragraphs. The first sits in §13.15 after **Resolution**:

> **User-auth issuance.** On a user-auth space the issuer of an interactive actor's `manager-caller`
> view connection is the auth service, at its callout, and the material is the user JWT the callout
> returns. The callout issues that view when the bearer's actor-ledger row is an interactive row, and
> the issued view carries the per-key accepted-row read beside its instance-pinned rows. It chooses
> the generation, persists evidence whose permissions are the set it signs and whose one source is
> that row, `{ space, bucket: "cotal_actors_<space>", key: "actor.<owner>.<actor>.<lifecycleUid>" }`,
> releases it, and writes the accepted row, all before it returns the JWT. The accepted token is the
> first 32 lowercase hex characters of SHA-256 over `"cotal.accepted.v1\0"` followed by the
> connection's inbox nonce: the client chose the nonce and derives the token from it, and no token is
> read from a request body. The source is live while the auth service's actor ledger holds a row for
> that owner and actor carrying that lifecycle UID; a revoked row, or a re-grant under another UID, is
> a dead source at the next resolution. Only the auth service attests this shape; every other host
> refuses it as a coordinate it cannot attest. A reconnect under the same nonce finds the existing
> accepted row. When the row names the same triple and the ceiling being minted is byte-identical to
> the recorded evidence, the callout renews that generation; otherwise it refuses the connect, and the
> client adopts a fresh generation only through a new connection under a new nonce. A managed row's
> view, the `agent` profile and every other view keep the legacy rail.

The second sits in §14.8 after **Resume, fork, local, restore**:

> **User-auth runs.** A user-auth run is hosted by a signerless participant manager, and its issuing
> host writes the admission. The issuing host admits a run-start whose caller has a derived user
> owner only when that owner is the manager's registered owner, the owner whose `supervise` grant
> registered the instance, so every user-admitted run on a participant manager belongs to that one
> owner. A caller-requested resume and every principal answer or amendment ride the versioned rail.
> The manager forwards the request subject it served with the attempt or operator issuance it asks
> for, and the issuing host re-parses that subject, requires a user caller's owner to be the run's
> admitted owner for a resume and the registered owner for an answer, resolves the caller's own
> issuance as live, and requires its publish ceiling to permit that subject. The issuing host
> subscribes to those resume and answer request subjects itself and never replies on them, and it
> issues for a forwarded subject only when it observed a caller publish that request and has not
> issued for it before, so a manager cannot forward a request its caller never sent. It reads what
> that request's envelope asked for and issues only that: a resume attempt for the run its `runId`
> names, and an answering issuance for the endpoint the answer names, the manager's own when it
> names none, that amends when the request set `amend: true` and answers when it did not. An
> answering operator issuance always carries the served subject. An amendment's issuance marks its
> pause with `amend: true`, and the issuing host then requires that pause settled `resumed` with an
> accepted answer instead of waiting. A legacy-rail answer is accepted only from a managed seat of
> that owner whose actor-ledger row is live, on the relay path of §14.5. A boot reconcile forwards
> no subject and continues under the original admission. This revision hosts no user-auth run on the
> signer-holding host's own manager.

No existing sentence is reworded.

## 7. Refusals

| Input | Where | Result |
|---|---|---|
| `run-start` from a user connection that read no accepted row | CLI | refused locally, naming the missing row; no legacy-rail retry |
| A reconnect whose ceiling changed (row narrowed, scope removed) | callout | `confirm` refuses with `failed-precondition`; the connection fails and a new connection gets a new generation |
| An accepted row under the connection's token naming another owner, actor or uid | callout, CLI | refused |
| User B's `run-start` reaching user A's participant manager | issuing host | `permission-denied`, registered owner |
| User B's `run-answer`, amend or `run-resume` for user A's run | issuing host | `permission-denied`, admitted owner |
| User A after `cotal actor revoke` or a re-grant | issuing host | `permission-denied`, source no longer live |
| A legacy-rail principal `run-answer` or `run-resume` on a participant manager | participant manager | `permission-denied`, `ai.cotal.ep.unbound-caller-authority` |
| A legacy-rail `run-answer` from a managed seat of another owner, or one whose row is gone | issuing host | `permission-denied` |
| An `operator.answers` request with no `served` | issuing host | `permission-denied`, after the pause check |
| A served resume or answer the issuing host did not observe on the broker, or a second forward of one it did | issuing host | `permission-denied`, not observed |
| A forwarded resume naming another run than the observed request, or an answer naming another endpoint or amendment | issuing host | `permission-denied`, another operation |
| An amendment for a pause that has no accepted answer | issuing host | `failed-precondition` |
| A boot-reconcile attempt for a revoked run | issuing host | existing refusal, `run <runId> was revoked; a revoked run is issued nothing (SPEC 14.8)` |

## 8. Residual risk

- An IdP session revoked at the IdP is not a source. The user's CLI keeps its live connections until
  their JWTs expire, at most `MAX_TOKEN_TTL_SEC` (900 seconds) after the last exchange, but no answer
  or resume they send can be issued, because the manager's host call needs a fresh IdP token. The
  attempt already driving keeps its last-good driver credentials until a renewal fails, as it does
  today when the authority service is unavailable.
- Each issued `manager-caller` connection, one per `cotal run` invocation, adds one evidence row, one
  attempt row and one accepted row to stores that keep every message. Static control instruments
  already issue once per invocation (`connect.ts:441`), and this matches that rate.
- The callout opens one issuer connection per issued connect, which adds latency to the callout's
  reply.
- Revoking a user's run on a participant manager has no user-facing route. `RunHosting.revoke` refuses
  on a signerless host (`run-hosting.ts:309`), and the host operator's `cotal run revoke --local`
  remains the only writer.
- User-mode seats spawned by the run answer through the relay path on the legacy rail. Their
  attribution rests on the managed row and the manager-held relay, as it does on a static mesh.
- A participant manager forwards the `run-start` subject it served, and the issuing host checks that
  the subject names a live issuance whose ceiling permits it and that a user caller is the manager's
  own owner, but it does not observe that this caller published it. A dishonest participant manager
  can therefore start runs for its own owner's live issuances and, as on main, for a static caller's,
  never for another user. Resumes and answers are bound to a request the issuing host observed;
  issue #2465 tracks the same binding for `run-start`.
- The pause token an answering issuance pins is still the manager's word. The issuing host checks the
  observed answer's endpoint and amendment and that the pause is waiting, or settled for an
  amendment, but a token is derived inside the run and only the run's journal maps it to a run and
  step. A dishonest participant manager holding one observed answer can therefore ask for a different
  pause on the `manager` endpoint than the one that answer named. Issue #2535 tracks it.

## 9. Acceptance for the implementation round

A private probe, not a committed test, through shipped entrypoints under a fresh root:

1. Control: the round-1 static run starts, answers and completes.
2. User A starts a run on A's participant manager: admitted, `provenance.kind` is `issued`, the
   caller names A's `cli` triple and generation.
3. A spawns and turns an owned seat in the program, the seat answers an `ask`, and A answers a
   checkpoint: both `by` values name A's principals.
4. A's manager restarts: the run resumes under epoch 2 with the same admission.
5. User B's start on A's manager, B's answer and B's resume of A's run: each refused as section 7 says.
6. `cotal actor revoke` for A's `cli` row, then A's answer and resume: refused, source no longer live.
7. A `run-start` that the probe publishes on the legacy rail under A's connection: refused as today.
8. The signer-holding host's own manager still refuses user mode by name.
