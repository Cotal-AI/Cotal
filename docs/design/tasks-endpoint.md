# A tasks endpoint contract

A design record, not a description of shipped behavior. Every claim about current behavior names
the file and the function it was read from. Everything else is proposed and says so.

**Citations.** Every `file` and function below was read in this worktree at `d3fbeb1fd`. No seed, key,
token, or credential value is reproduced anywhere.

## The question

Nothing in this repository lets a kanban board or an issue tracker take part in a space. Work is
coordinated in chat and in each tool's own interface, so a task is never bound to the seat doing it
or to the environment that seat runs in, and a dashboard reading a space cannot show tasks beside
agents.

This record states the contract a provider follows so that a task can be bound to a seat, read by a
dashboard, and written by the seat itself, with no new subject, no new message kind, and no new core
code. A tasks provider is an ordinary `service` endpoint under SPEC §13: it registers capability
clusters, publishes its contract artifacts, and answers `describe`.

### What exists today

The repository has one shipped cluster document. `implementations/manager/src/manager-service-contract.ts`,
`managerClusterDocument`, returns revision 15 with 28 commands, `attributes: []`, `events: []`, and
`class: "ephemeral"` on every row. `managerShippedSurface` in the same file cross-checks that count
against the compiled contracts. Evaluating those two functions in this worktree produced that
result, and also showed that no command declares `effect` and none declares `admissionCeiling`, and
that the only targeted authorization mode sets in use are `owner` with `any`, and `self` alone.

So the reference implementation has never registered a record-derived attribute, a cluster event, or
a journal-class command. The declarations are nonetheless representable. `packages/core/src/endpoint-cluster.ts`,
`parseClusterDocument`, parses commands fully and carries `attributes` and `events` opaquely as
`unknown[]`; it refuses a `journal`-class command that declares no `admissionCeiling`, refuses an
`action` marker on a non-journal class, and refuses `readinessDeadlineMs` without that marker.

`effect` is not reachable. `parseClusterDocument` does not read the field. `packages/core/src/endpoint-service.ts`,
`ServiceSpec`, pins `protocol: { v: 1 }`, and `parseServiceSpec` fails closed on any other value.
`packages/core/src/endpoint-serve.ts`, `DESCRIBE_ANSWER_SCHEMA`, fixes `descriptor.protocol.v` to the
constant `1`. Repeat safety is carried off the wire instead, by `REPEAT_SAFE_COMMANDS` and
`isRepeatSafeCommand` in `packages/core/src/endpoint-grants.ts`, whose own comment says the table must
not survive `protocol.v: 2`.

What a caller can see is narrower than what a document declares. `packages/core/src/endpoint-invoke.ts`,
`resolveService`, builds each `ResolvedCommand` with command, contract, class, targeted, modes, and
capability. `implementations/cli/src/commands/describe.ts`, `describeCmd`, prints the command name, the
capability, and the targeting shape.

Grants are built from the capability and the target block. `packages/core/src/endpoint-grants.ts`,
`EpCapability`, is `{ endpoint, command, routes?, instanceId?, target?, journal? }`. `epRequestGrantRows`
pins the caller triple into every granted subject, and `targetGrantTokens` throws when an `owner`-mode
grant names a target owner that is not the caller's own owner.

Record kinds are a registered table, not a free namespace. `packages/core/src/endpoint-records.ts`,
`RECORD_KINDS`, pins each kind's key grammar, writer roles, and mediation class, and `registerRecordKind`
refuses a single-label kind name as core-reserved. SPEC §13.9 "Mediated reads" states that no untrusted
capability holder is granted any raw JetStream read of a control-surface stream.

Presence carries the two seat-side facts this contract may bind to. `packages/core/src/types.ts`,
`Presence`, declares `environment?: string` as an opaque reference whose meaning belongs to the provider
that issued it, `lifecycleUid?` as advisory, and `condition?`. `packages/core/src/endpoint.ts` reads
`COTAL_ENVIRONMENT` once in the constructor and publishes it unparsed in `publishPresence`. SPEC §6
marks `environment` as MAY and says core MUST NOT parse it, and says authority checks use the trusted
lifecycle mapping rather than presence.

No tasks endpoint exists. `git grep` for `ai.cotal.tasks` returns nothing, and the only cluster URN
constant in the tree is `MANAGER_CLUSTER_URN = "ai.cotal.manager"`.

## 1. The cluster

Proposed. One cluster, `ai.cotal.tasks`, revision 1.

The endpoint **name** is not pinned by this contract. A deployment chooses it, subject to the existing
rules: `packages/core/src/endpoint-subjects.ts`, `endpointToken`, requires DNS-shaped labels and a token
under 64 characters, and SPEC §13.9 says core single-label names require operator provisioning authority
while reverse-DNS names bind to their registered owner. A reader resolves the endpoint by name through
`describe`; nothing in this contract depends on which name was chosen.

### Attributes

Revision 1 declares **no attributes**, and that is a decision rather than an omission.

An attribute rides the record contract (SPEC §13.7: attribute reads and subscribes ride the record
contract, never ephemeral replies), and a record lives in the per-space records bucket under a
registered kind. Two consequences make a task-bearing attribute wrong here. Records are bounded
per-space state with mediated writers, while a task store is unbounded and owned by the provider, so
projecting tasks into records builds a second copy of the provider's store inside the space. And
SPEC §13.9 denies every untrusted capability holder a raw read of that bucket, so a dashboard could
not read the projection without a record read mediator, which this repository does not have for
arbitrary kinds.

An attribute becomes admissible when both of those change: a bounded value that is genuinely one key
rather than one key per task, and a mediated read path a dashboard may hold. Section 8 records that
as an open question rather than assuming it.

### Events

One event, `board-changed`, on the cluster event topic `ev.ai_cotal_tasks.board-changed`
(SPEC §13.2 reserved event topics: `ev.<cluster>.<event>`).

Payload, closed: `{ changeSeq: integer, observedAt: integer }`. `changeSeq` is a monotone counter the
provider advances when anything in its store that this contract exposes has changed. `observedAt` is
epoch milliseconds.

The payload carries no task id, no title, no status, and no count. A reader learns only that a refresh
is worth making, and then makes that refresh under its own authority, which is where per-reader scoping
happens. An event read grant is a topic subtree (SPEC §13.9 caller grants), so every holder of the
subtree sees every event on it; keeping the payload down to a counter and a timestamp is what makes
that grant safe to hand out.

Events are notifications, not facts. SPEC §13.4 states that cluster events do not pass through the
canonicalizer, carry no acceptance semantics, and must not drive effects that require canonical
acceptance. A reader that treated a missed `board-changed` as "nothing changed" would be wrong, so a
conformant reader also refreshes on its own schedule and treats the event as an early wake only.

### Commands

Every command in revision 1 is `class: "ephemeral"`. The SPEC §13.4 decision rule is that a crash
meaning "just re-ask" is ephemeral, long-lived state something converges on is record, and state that
must survive restart or be audited, metered, or compensated is journal. A tasks provider owns the
durable task store, so the durable thing is already the provider's, and a request lost to a broker
restart is re-asked by its caller. Nothing in revision 1 is metered or compensated on the Cotal side.

`effect` is declared for each command below as authoring intent. It **cannot be registered today**:
`ServiceSpec` pins `protocol.v` to `1`, and SPEC §13.7 states that an instance whose clusters declare
`effect` must register and describe at `protocol.v: 2`. Until that version exists, a provider registers
without the field and a client gets no repeat-safety information from the wire, as it does
against the manager today. The declarations below are what the cluster carries at revision 1 of a
`v: 2` deployment, and they are named here so that the author's judgement is recorded once rather than
re-derived per client.

Targets are always a principal plus a lifecycle uid (SPEC §13.2). A task id is never a target; it
rides the arguments. A targeted command therefore says "the seat this acts on behalf of", and the
task it acts on is named in `taskId`.

| Command | Class | Effect | Targeting | Capability | Idempotency key |
| --- | --- | --- | --- | --- | --- |
| `list-tasks` | ephemeral | read | untargeted | `tasks.read` | not applicable |
| `get-task` | ephemeral | read | untargeted | `tasks.read` | not applicable |
| `my-tasks` | ephemeral | read | targeted, mode `self` | `tasks.self` | not applicable |
| `create-task` | ephemeral | write | untargeted | `tasks.write` | envelope `id` |
| `bind-task` | ephemeral | write | targeted, modes `owner` and `any` | `tasks.bind` | `taskId` with the target triple |
| `claim-task` | ephemeral | write | targeted, mode `self` | `tasks.self` | `taskId` with the caller triple |
| `update-task` | ephemeral | write | targeted, mode `self` | `tasks.self` | envelope `id` |
| `administer-task` | ephemeral | write | untargeted | `tasks.admin` | envelope `id` |

Per-command shapes, all proposed:

- **`list-tasks`**. Input `{ cursor?: string, limit?: integer, status?: string[] }`. Output
  `{ tasks: TaskSummary[], appliedLimit: integer, nextCursor?: string, observedAt: integer, changeSeq: integer, stale?: StaleMarker }`.
  A bounded page of summaries for the space the endpoint serves. `limit` has a provider ceiling, and
  `appliedLimit` reports the bound the provider actually used, so a caller that asked for more learns it
  was narrowed rather than inferring completeness from a short page.
- **`get-task`**. Input `{ taskId: string }`. Output the full task record of section 2, or `not-found`.
  Separated from `list-tasks` because a list carries summaries and a dashboard should not have to page a
  whole board to read one task.
- **`my-tasks`**. Input `{ cursor?: string, limit?: integer }`. The caller triple is the query, which is
  why it is targeted at mode `self` and takes no seat argument at all. This is the shape `turn-pending`
  already uses in `manager-service-contract.ts` (`TURN_PENDING_OUTPUT_SCHEMA`, "Self-targeted, so the
  caller triple IS the query; there is no other input"), widened only by the page controls, because a
  seat's own list is bounded by nothing but the board and an unpaged read of it would be the one
  unbounded reply in this cluster. Output
  `{ tasks: TaskSummary[], appliedLimit: integer, nextCursor?: string, observedAt: integer, changeSeq: integer, stale?: StaleMarker }`.
- **`create-task`**. Input `{ title, brief?, status?, evidence? }`. Output the created record. Untargeted
  because creating a task acts on the board, not on a seat. It takes **no** binding argument: a task is
  created unbound and bound by a second call. The reason is section 5's enforcement split. A binding
  argument on an untargeted command would be a seat named in a payload, and the broker confines target
  tokens in the subject, not fields in a body, so the check that a caller may bind to that seat would
  move from the broker into the provider. Two calls keep every binding write on a targeted command.
  `status` admits `open`, `blocked`, `done`, and `dropped`, and refuses `claimed` with `bad-request`:
  `claimed` asserts a bound seat, and this command creates nothing bound.
- **`bind-task`**. Input `{ taskId, expectedBinding?: BindingRef | null }`, where `BindingRef` is
  `{ owner, actor, lifecycleUid }`, the three coordinates of section 2's binding without its recorded
  metadata. The target block names the seat. Output the updated record. `expectedBinding` is the
  optimistic check: `null` asserts the task is currently unbound, a `BindingRef` asserts it is bound to
  that exact triple, and a mismatch is `conflict`. Absent means no check, which is the operator override.
- **`claim-task`**. Input `{ taskId }`. Targeted at mode `self`, so the seat can only ever bind a task to
  itself. Refuses `conflict` when the task is already bound to another seat. A seat holding only
  `tasks.self` cannot rebind anything, which is the property section 5 rests on.
- **`update-task`**. Input `{ taskId, status?, brief?, evidence?, note? }`. Targeted at mode `self`. The
  provider serves it only when the task's recorded binding equals the broker-authenticated caller triple,
  including the lifecycle uid; anything else is `permission-denied`. This is the one command a seat needs
  to progress, attach evidence to, and close its own work, and it is one command rather than three
  because a status change and the evidence justifying it belong in the same call.
- **`administer-task`**. Input `{ taskId, status?, unbind?: true, note? }`. Untargeted and
  capability-gated. It exists for the case a self-mode command cannot cover: a seat that is gone and left
  a task open. It can clear a binding and it can set a status; it cannot create one, because binding to a
  seat is a targeted act and `bind-task` is where it stays. The untargeted plus capability-gated shape is
  the one the manager already uses for its operator instruments; `manager-service-contract.ts` states it
  in the module header ("every admin-class command is untargeted + capability-gated") and `ROWS` carries
  it for `purge`, `launch`, and the resume family.

`StaleMarker` is `{ staleAsOf: integer, reason: string }`, the shape section 4 requires on a degraded
read. `staleAsOf` is epoch milliseconds and `reason` is a bounded provider string.

Idempotency is by envelope `id` where the table says so, which is SPEC §13.8's ephemeral rule
(idempotent commands by `id`, handler-local, within result retention). `bind-task` and `claim-task` are
additionally idempotent by their own semantics: re-issuing a bind that already holds returns the same
record rather than a second binding. `list-tasks`, `get-task`, and `my-tasks` need no key because they
change nothing.

SPEC §13.8 also states that a command idempotent by `id` is not thereby `read`, and this contract does
not claim otherwise: the four `write` rows above stay unsafe to repeat without a proof of non-execution,
whatever `id` a re-issue carries.

### If a command becomes journal-class

No command in revision 1 is journal-class, so no `admissionCeiling` is declared and
`parseClusterDocument` accepts the document. A deployment that needs an audited, durably decided bind
declares `bind-task` as `class: "journal"` at a new revision, and must then declare its ceiling, because
`parseClusterDocument` refuses the class without one.

The ceiling is derived from the input bounds, not chosen: `maxBytes` covers the largest canonically
serialized `bind-task` input the section 2 field bounds permit, plus the envelope, with headroom;
`maxDepth` is that input's own nesting depth, which is 2, the outer object and the `expectedBinding`
object inside it; `maxItems` is the largest member count the input schema admits. SPEC §13.7 requires
the ceiling to be declared rather than compiled in, because it decides what a submission durably becomes,
and two implementations that agreed on the wire while disagreeing on a constant would write different
permanent decisions for identical bytes.

## 2. The task record

Proposed. One closed shape, versioned by a literal so a reader can branch on it without inspecting the
cluster revision. The precedent is `ManagedEnvironmentRecord.version` in
[environment-provider-hosted.md](environment-provider-hosted.md).

```ts
interface Task {
  version: "ai.cotal.tasks.task/v1";
  taskId: TaskText;          // provider-minted, opaque, stable for the life of the task
  space: TaskText;           // the space this task belongs to
  title: TaskText;           // <= 200 UTF-8 bytes
  brief?: TaskBrief;         // <= 4096 UTF-8 bytes
  status: TaskStatus;
  statusSource?: TaskText;   // the provider's native state name, relayed verbatim, never parsed
  binding?: TaskBinding;     // absent means unbound
  evidence: TaskEvidence[];  // <= 32 entries
  createdAt: number;         // epoch ms
  updatedAt: number;         // epoch ms
}

type TaskStatus = "open" | "claimed" | "blocked" | "done" | "dropped";

interface TaskBinding {
  owner: TaskText;           // the seat principal's owner half
  actor: TaskText;           // the seat principal's actor half
  lifecycleUid: TaskText;    // the seat's lifecycle uid; a fresh incarnation is a different value
  environment?: TaskText;    // copied verbatim from the seat's presence card, or absent
  boundAt: number;           // epoch ms
  boundBy: TaskText;         // the broker-authenticated principal that made the binding
}

interface TaskEvidence {
  kind: "commit" | "branch" | "run" | "review";
  ref: TaskText;             // opaque to this contract; the provider never parses it
  addedAt: number;           // epoch ms
}
```

`TaskSummary` is the same shape without `brief` and without `evidence`, which is what makes a page
bounded.

**Identity.** `taskId` is minted by the provider, opaque to Cotal, and stable for the task's life. It
is bounded to 128 UTF-8 bytes with no control characters. It is never a credential and never encodes
one.

**Status vocabulary.** Five values, closed, and closed deliberately. The rule for extending it is that
it is not extended within this URN. A provider whose own model has more states maps each onto one of
the five and puts its native name in `statusSource`, relayed verbatim and never parsed. The precedent is
`PresenceCondition.source` in SPEC §6, a harness-native value carried beside a closed code.

The reason is that adding a member to a closed output enum breaks every reader that switched on it,
while SPEC §13.7 requires changes within a revision line to be additive. A sixth status is therefore a
new cluster URN version, which is a migration a deployment performs on purpose, rather than a revision
bump a reader discovers by failing to match.

`open` means nobody is working on it. `claimed` means a seat is bound and working. `blocked` means a
seat is bound and cannot progress. `done` and `dropped` are the two terminals, and they are two rather
than one because "finished" and "abandoned" are the distinction a board exists to make.

**Binding.** A binding names the full seat principal plus the lifecycle uid. It is scoped by the space
the endpoint serves. It is never named by principal alone: `docs/control-surface.md` records that a
principal `owner.actor` is a reusable routing alias, that a despawn frees the actor name, and that a
later spawn may legitimately reuse it, so the alias alone is never identity and a binding keyed on it
would be silently inherited by whoever next holds the name.

**Environment.** `binding.environment` is the environment **association**, not a binding key and not an
identity. Several seats may share one environment reference, so the reference can never identify a seat.
It is copied verbatim from the bound seat's presence card at bind time when the card carries one, and
omitted when it does not. Absent means unknown; it is never inferred from a working directory, a host
name, a display name, or a provider-specific handle, and no provider-specific handle is a fallback join
key. It is never parsed, which is the rule SPEC §6 already states for core and which this contract
adopts for the provider.

Environment metadata carries no authority. Nothing in this contract grants, checks, widens, or narrows a
capability because two records share an environment reference. A reader may group a board by that
reference for display; an authorization decision that consulted it would be reading a display value as a
grant.

**Evidence.** Each entry declares its kind and carries an opaque `ref`. The kinds are the four the brief
names, and the contract parses none of them: a `commit` ref is a string to this contract, not a validated
object name, because validating it would make the contract depend on one version control system.
Bounded at 32 entries and 512 UTF-8 bytes per ref, so a record stays a record.

**Timestamps.** `createdAt` and `updatedAt` are epoch milliseconds, as `ManagedEnvironmentRecord` already
uses for `createdAt`, `stoppedAt`, `expiresAt`, and `probedAt`.

**What the record excludes.** No secret of any kind: no key, token, bearer, credential path, signed URL,
or launch material identifier. No tool output body. No transcript, no message history, and no quoted
agent turn. No absolute host path. The reason is the same one `validateHostedEnvironmentRecordText`
enforces in [environment-provider-hosted.md](environment-provider-hosted.md): a dashboard may read the
whole record, so the record must hold nothing a dashboard reader may not see. Every string field above is
a bounded `TaskText` or `TaskBrief`, refusing control characters and credential-shaped text before the
provider stores it.

## 3. Binding rules

Proposed.

**Who may bind.** Two paths, and no third. A caller holding `tasks.bind` binds a task to a named seat
through `bind-task`, at mode `owner` for a seat under its own owner or at mode `any` for the operator
instrument. A seat holding `tasks.self` binds an unbound task to itself through `claim-task`, and can
reach no other triple, because mode `self` pins the whole caller triple in the subject.

Both paths are targeted commands, and that is the invariant rather than a coincidence: a binding names a
seat, the broker confines target tokens in the subject, and an untargeted command naming a seat in its
payload would move that check into the provider. So no untargeted command in this cluster writes a
binding. `create-task` takes no binding argument, and `administer-task` can only clear one. Clearing is
safe untargeted because it names no seat; it only removes what is already recorded.

**How a binding is confirmed.** The provider checks two different things for two different reasons, and
keeping them apart is the point.

Authority is the broker grant plus the broker-authenticated subject. It is never presence. SPEC §6 states
that presence `lifecycleUid` is advisory for display and that authority checks use the trusted lifecycle
mapping rather than presence, and this contract does not weaken that. A provider that consulted presence
to decide whether a bind was allowed would be treating a self-published advisory record as a grant.

Reachability is a separate, optional check. Before recording a binding the provider may confirm that the
target triple has a presence entry whose `lifecycleUid` equals the target uid, and refuse
`failed-precondition` when it does not. That is an operator convenience so a typo does not create a
binding to nothing. It is not a security control, it is declared as such, and a deployment may disable it
without changing who may bind. The environment reference is read from that same card when it is present.

**When the lifecycle uid changes.** A fresh incarnation is not the same seat, and this contract never
repairs the difference. A binding names a uid; a seat whose uid differs does not match it. Three
consequences, each stated so a reader cannot infer a friendlier one:

- `my-tasks` for the new incarnation returns the tasks bound to the new uid, which is normally none.
- `update-task` from the new incarnation against the old binding is `permission-denied`. It is not
  silently accepted and it is not silently retargeted.
- The task keeps its binding. It does not revert to `open`, and it is not auto-rebound. It becomes a
  task whose bound lifecycle is no longer live, which is a state an operator resolves: `bind-task` to
  move it to a live seat, or `administer-task` with `unbind` to return it to the board.

The reason for keeping the binding rather than clearing it is that clearing would destroy the only
record of who was working on it, and a board's value is largely that record.

**What a dashboard shows for a task whose seat is offline.** The binding, with its principal and its
uid, and liveness as a **separate derived column** that the tasks provider does not own. A dashboard
derives liveness from presence, which is a different source with its own staleness, and it labels that
column with the three-state vocabulary the manager already uses: `AGENT_ROW_SCHEMA` in
`manager-service-contract.ts` declares `meshView` as `current`, `stale`, or `unpopulated`, with the
comment that `stale` means the watch has been silent past its time to live and `unpopulated` means
absence means nothing.

A bound task whose seat is offline is never displayed as unassigned, and a bound task whose presence
view is `unpopulated` is never displayed as offline. Both collapses would report an observation the
dashboard did not make.

## 4. How a dashboard reads

Proposed, and stated as requirements rather than preferences.

**The authoritative read is a command, not a subscription.** A reader calls `list-tasks`, `get-task`, or
`my-tasks` on demand, bounded and paginated, under its own authority, and the broker enforces the
reader's own capability on every call. There is no second task store in a KV bucket and no projection of
task bodies into the space.

Three reasons, each independent. SPEC §13.9 "Mediated reads" denies untrusted capability holders any raw
JetStream read of a control-surface stream, so a reader could not watch a records-bucket projection
anyway. `RECORD_KINDS` and `registerRecordKind` in `packages/core/src/endpoint-records.ts` make record
kinds a registered table with pinned writers, so a provider cannot add a task kind by declaring one in a
cluster document. And a per-reader authority check is only possible on a call: a broadcast reaches
whoever holds the subject, so publishing bodies would push the board's access control into the channel
grant and out of the provider.

**Change notification is a wake, not a feed.** `board-changed` carries `{ changeSeq, observedAt }` and
nothing else, so a reader learns when to refresh and refreshes under its own authority. A reader that
reconstructed board state from the event stream would be driving state from notifications SPEC §13.4
says are not facts.

**The bound on what a provider publishes into the space.** A counter and a timestamp on the event plane.
That is the whole of it. The provider's store is never published, not in full and not in summary: no
title, no status, no count, and no task id crosses the event plane. A reader holds a summary only as the
result of its own authorized call, and holds it for as long as it chooses, knowing it is a snapshot.

**Unreadable is distinguishable from empty, always.** This is a contract requirement and the reason it is
one is that an empty list is the most dangerous wrong answer a board can give: it looks like success.

- A provider that cannot read its store fails the command with `unavailable`. It never returns
  `{ tasks: [] }`. The error catalog is fixed at `EP_ERROR_CODES` in
  `packages/core/src/endpoint-error.ts`, and `unavailable` is a member of it.
- A provider serving from a degraded or lagging source returns its page **with** an explicit
  `stale: { staleAsOf: integer, reason: string }` marker. The result is usable and labelled, never
  silently fresh.
- `{ tasks: [], observedAt, changeSeq, appliedLimit }` with no `stale` marker is a positive assertion
  that the provider read its store and the store holds nothing matching. It is the only shape that means
  "no tasks".
- A reader that observes a `changeSeq` lower than one it has already seen treats the answer as stale
  rather than as a rollback, and refreshes.

**Attributes are not used, and section 1 says why.** The choice between an attribute and a command is not
a style preference here: an attribute is a record read and a command is a request, and only one of those
has an authorization seam the provider controls per reader.

## 5. Authority

Proposed. Five capabilities, one per tier of reach, following the one-capability-per-tier vocabulary the
manager's module header already documents.

| Capability | Commands | Who holds it |
| --- | --- | --- |
| `tasks.read` | `list-tasks`, `get-task` | any reader authorized to see the board |
| `tasks.self` | `my-tasks`, `claim-task`, `update-task` | every seat, at mode `self` only |
| `tasks.write` | `create-task` | an operator credential, or a seat a deployment chose to trust with creation |
| `tasks.bind` | `bind-task` | an operator credential; mode `any` only under operator policy |
| `tasks.admin` | `administer-task` | an operator credential only |

**A seat writing its own task** holds `tasks.self`. That capability mints only mode `self` rows.
SPEC §13.9 states that `self` is broker-confined end to end including the lifecycle uid, so a seat
cannot even emit a request subject naming another seat's triple; the request is refused by the broker
before the provider sees it.

**An operator creating and binding** holds `tasks.write` and `tasks.bind`. `epRequestGrantRows` in
`packages/core/src/endpoint-grants.ts` builds the granted subject from the capability's authz mode and
target tokens, and `targetGrantTokens` in the same file throws when an `owner`-mode grant names a target
owner other than the caller's own. An `any`-mode row may carry the literal `*`, and the same function's
comment records that it is mintable only under operator policy, enforced by the minting authority. So the
operator tier is a broker grant, not a provider-side role check.

**Why a seat cannot be tricked into rebinding someone else's task.** Three independent layers, and the
contract needs all three stated because each covers a case the others do not.

The broker layer: a `tasks.self` credential holds no subject row that names another triple, so a
crafted request is denied at publish. The provider layer: the provider derives the caller from the
broker-authenticated subject and never from the payload, which is the rule
`manager-service-contract.ts` already records for `run-answer` ("No `by`: the answerer is the caller as
the manager knows them, decided from the authenticated principal at the serve layer"). The contract
layer: no self-mode command takes a target seat as an argument at all. `claim-task` takes only a
`taskId`, and `update-task` takes only a `taskId` with its changes, so there is no field in which a
foreign triple could be supplied, whatever a caller was persuaded to send.

Rebinding lives in `bind-task` alone, and it is never minted to a seat holding only `tasks.self`.
`administer-task` can clear a binding but cannot write one, so the admin credential can free a task and
not hand it to a seat of its choosing without going through the targeted command.

**What this does not protect.** A seat that legitimately holds `tasks.bind` at mode `owner` can rebind
any task under its own owner, including another seat's. That is the same reach `despawn` already has,
and `docs/control-surface.md` records the reasoning under seat input: the own-owner rule covers every
seat under an owner rather than only the ones a caller launched. A deployment that does not want that
reach does not mint `tasks.bind` to seats.

## 6. Conformance

Proposed. A provider may call itself a tasks endpoint when a reviewer can exercise each of the following
against it and observe the stated result. Every check is phrased against what `cotal describe` and
`cotal invoke` actually surface: `describeCmd` prints the command name, the capability, and the
targeting shape, and `invokeCmd` prints the reply data or the error code with its message.

**Two checks need more than today's CLI, and the record says which rather than implying the CLI can do
more than it does.** `resolveTarget` in `implementations/cli/src/commands/describe.ts` builds a target
block from `--self` alone, or from `--name` against the manager endpoint only: it exits with a named
refusal for any other endpoint, because alias resolution runs through the manager's `inspect`. So a
reviewer exercising an `owner`-mode or `any`-mode command against a tasks endpoint supplies the target
triple through a client calling `invokeCommand` directly, until that endpoint has an alias resolver.
And `invokeFlags` in the same file carries no id flag, while `epCall` in
`packages/core/src/endpoint-verbs.ts` uses `op.id` when pinned and a fresh `nonce()` otherwise
(`const requestId = op.id !== undefined ? assertIdToken(...) : nonce()`), so a repeated `cotal invoke`
sends a different envelope id every time and cannot demonstrate id idempotency. That check pins the id
through `invokeCommand`'s `opts.id`.

1. `cotal describe <endpoint>` lists the eight commands of section 1 with the capability and the
   targeting shape that table gives. A missing command, a different capability, or a different targeting
   shape is a failure.
2. `cotal invoke <endpoint> list-tasks` on an empty board returns `tasks: []` with an `observedAt`, a
   `changeSeq`, and an `appliedLimit`, and no `stale` marker.
3. With the provider's store made unreadable, the same call fails with `unavailable`. A reviewer who sees
   `tasks: []` here has found the failure this contract exists to prevent.
4. `cotal invoke <endpoint> get-task --args '{"taskId":"<absent>"}'` returns `not-found`, not an empty
   object and not a null task.
5. `cotal invoke <endpoint> my-tasks --self` returns the caller's own bound tasks. Invoking it without
   `--self` is refused as a targeted command with no target, which `invokeCommand` in
   `packages/core/src/endpoint-invoke.ts` raises as `bad-request` before anything is published.
6. `cotal invoke <endpoint> claim-task --self --args '{"taskId":"<unbound>"}'` binds the task to the
   caller triple, and a second identical call returns the same record rather than a conflict or a second
   binding. This one holds under the CLI, because `claim-task` is idempotent by `taskId` with the caller
   triple rather than by envelope id.
7. `cotal invoke <endpoint> claim-task --self` against a task already bound to another seat returns
   `conflict`.
8. `cotal invoke <endpoint> update-task --self` against a task bound to another seat returns
   `permission-denied`, and the record is unchanged when read back with `get-task`.
9. A `bind-task` call from an operator credential, with a target block naming a seat's owner, actor, and
   lifecycle uid, binds the task, and the returned record carries that same triple. The same call from a
   credential holding only `tasks.self` is refused by the broker before the provider is reached, because
   no `tasks.self` grant mints an `owner`-mode or `any`-mode row.
10. After the bound seat is stopped and a new seat is spawned under the same name, `get-task` still shows
    the original `lifecycleUid`, and `my-tasks --self` from the new seat does not list the task.
11. A task bound to a seat whose presence card carried an `environment` reference shows that reference
    verbatim in `binding.environment`. A task bound to a seat whose card carried none omits the field.
    No value appears that the card did not carry.
12. `cotal invoke <endpoint> list-tasks --args '{"limit":<large>}'` returns at most the provider's own
    ceiling and reports that ceiling in `appliedLimit`, rather than returning the whole board.
13. Reading any task returns a record carrying no secret, no tool output body, and no transcript text.
14. Two `create-task` calls pinning the same envelope id create one task. A reviewer pins the id through
    `invokeCommand`'s `opts.id`, for the reason stated above.

Checks 3, 8, 10, and 11 are the ones that distinguish a conformant provider from a plausible one; a
provider passing only the others has implemented a board, not this contract.

## 7. Providers

Two implementations are intended, and neither belongs in the contract by name. The first is a
self-hosted board a team runs beside its own broker, which owns its store outright and maps its columns
onto the five statuses of section 2 directly. The second is a hosted issue tracker, which holds the
authoritative store remotely and maps its own issue identity onto `taskId`, its workflow states onto the
five statuses with the native name carried in `statusSource`, its linked commits and pull requests onto
the four evidence kinds, and its assignee onto a binding only where a real seat principal and lifecycle
uid exist. An assignee that is a human account is not a seat and produces no binding. Neither
implementation puts its own vocabulary, identifiers, or verb names on the Cotal wire; both speak the
eight commands above and nothing else.

## 8. Open questions

1. **Does an attribute belong here at all.** Section 1 declares none, on the grounds that records are
   bounded shared state and there is no mediated record read path an untrusted dashboard may hold.
   Blocks: whether a dashboard can ever get a level-triggered board view rather than polling.
   Decided by: whoever owns the record read mediator question in SPEC §13.9, since the answer here
   follows from that one.

2. **Whether `changeSeq` is per endpoint or per reader scope.** A single counter tells a reader with a
   narrow view to refresh for changes it cannot see, which is harmless but wasteful; a per-scope counter
   leaks the existence of changes outside the reader's view unless it is computed per reader, which
   costs the provider a query per event. Blocks: the payload of `board-changed` and the polling cost of
   a large board. Decided by: the contract author, before revision 1 is registered anywhere.

3. **Whether `bind-task` must become journal-class.** Section 1 argues ephemeral is honest because the
   provider owns the durable store. A deployment that must audit who bound what, from Cotal's own facts
   rather than the provider's log, needs a durable decision and therefore the journal class with a
   declared ceiling. Blocks: the cluster revision at which an auditing deployment can adopt this.
   Decided by: the deployment that has the audit requirement, since the cost falls entirely on it.

4. **Whether a seat may create tasks.** The table puts `create-task` under `tasks.write` and leaves the
   holder to the deployment. A mesh where agents create their own work items is a different system from
   one where an operator sets the board, and the contract currently permits both without saying which is
   intended. Blocks: the default capability set a deployment mints for an ordinary seat.
   Decided by: the deployment operator.

5. **What happens to a task whose space is torn down.** The record carries `space`, and the provider's
   store outlives the space. Nothing here says whether the provider prunes, archives, or retains.
   Blocks: the retention story and any claim about a board surviving a broker rebuild.
   Decided by: the provider author, with the deployment's retention policy as the input.

6. **Whether `statusSource` is enough for a hosted tracker.** Section 2 maps a richer workflow onto five
   statuses with the native name carried beside. A tracker with states that do not map cleanly onto
   those five would have to choose a lossy mapping, and the contract gives no guidance on which loss is
   acceptable. Blocks: the second provider implementation. Decided by: that provider's author, whose
   mapping becomes the worked example.

---

**Status: design.** Nothing in this record is implemented. No tasks endpoint, cluster URN, record kind,
or command in it exists in this repository. The sections describing current behavior cite the files they
were read from; everything else is a proposal, and a review gate on this document precedes any code.
