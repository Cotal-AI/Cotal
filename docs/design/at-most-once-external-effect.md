# At-most-once external effects in cotal-lang

A design record, not a description of shipped behavior. Every claim about current behavior names the
file and the function it was read from. Everything else is proposed. Once this record is approved
the surface below is frozen, and the implementation follows it as written.

## 1. The problem, measured at this head

A program whose step writes to a far side (an HTTP POST that creates a comment) cannot ask the
language to perform that write at most once across a crash and resume.

What exists today, read from `packages/lang/src/perform.ts` (`performEffect`) and
`packages/lang/src/journal.ts`:

- `Journal.begin` appends a `pending` entry carrying `requestId` and `attempt` and is awaited
  before the handler is called. A step with no entry was never started.
- `Journal.lookup` answers `pending` for an entry that began and never settled.
- On `pending`, `performEffect` calls the same handler method again, with the recorded
  `ctx.requestId`, and with `ctx.resume` set to whatever the first attempt passed to `ctx.bind`.
  spec/cotal-lang.md §10.4 and §10.7 specify that re-dispatch.
- SPEC.md §13.8 (idempotency scope) says an external side effect is exactly-once only when the far
  side honors the propagated idempotency key, and at-least-once otherwise.

So a handler whose far side honors no key (GitHub's comment API is one) performs the write twice
when the process dies after the write and before the settle. `ctx.bind` narrows the window and does
not close it: a crash between the write and the bind leaves a `pending` entry with no `external`.
Both cases were measured before this record was written, through the package's public exports
(`run`, `resume`, `Journal`, `SimHandler`), with a real process exit as the crash.

`EFFECT_KINDS` in `packages/lang/src/primitives.ts` is spawn, turn, ask, checkpoint, sleep, wait,
waitUntil, notify, monitor and conclave, and none of them changes that recovery rule.

## 2. What this adds, in one sentence

A new scope primitive, `once`, under which every step is dispatched at most once per step key: a
resume that finds such a step begun and unsettled does not dispatch it again; it reports the outcome
as unknown by opening a **hold**, an ordinary checkpoint minted under a token derived from the step's
recorded request id, which a human or the far side settles with the step's result.

A dispatch is one call of the step's handler method under the step's recorded request id that does
not end in a refusal. A handler that throws `EffectRefused` states that it performed nothing
(`packages/lang/src/effects.ts`), the entry settles `refused`, and the next activation dispatches
the step as a fresh attempt (§4.2), so a refused call is not a dispatch. What a handler does inside
one call is its own: an `ask`'s `attempts`, which the handler spends re-asking after schema-failed
replies, and an agent's own retries inside its turn are not dispatches, and `once` does not bound
them. A step whose writer retries inside one call is at-most-once only if that writer is. The
hold's own `handler.checkpoint` calls (§4.3) are not dispatches of the step either: they run under
the hold id, never under the step's request id, and a hold re-attaches after a crash as any
checkpoint does. No `checkpoint` step runs inside `once` (§4.2), so a `handler.checkpoint` call at a
key under a `once` frame is always a hold.

Nothing becomes exactly-once. The trade is liveness for the bound: a crash inside the window now
costs a settle, not a second write. A host restart while a wrapped step is in flight costs the same
settle, which is why only the step that writes should be wrapped.

## 3. The surface

### 3.1 Name

`once`. The syntax table names a scope by the shape of the work it governs, in one short word where
one exists (`parallel`, `race`, `conclave`), and puts the step name in the option bag. `once` names
the guarantee in one word, it is the issue's `effectOnce` without the prefix every primitive already
carries, and it is not a builtin, a reserved name, a value name or a forbidden global today.
Rejected: `effectOnce` (redundant prefix), `atMostOnce` (longer, same meaning), `idempotent` and
`exactlyOnce` (both claim a property this primitive does not give).

Becoming a reserved name means a program that declares its own `once` binding is refused (L2002,
spec/cotal-lang.md §3). That is the one breaking edge, and it is why the changeset is a
minor.

### 3.2 Signature

```js
const res = await once(async () => {
  return await ask(publisher, { name: "publish", schema: { commentId: "number" } })
}, { name: "publish-360" })
```

`once(fn, { name }) -> value`

- `fn` is a function of no arguments. It runs as the scope's single branch, `in`, and the scope's
  value is what `fn` returns.
- `name` is required and is a string literal (L3012, L3013), like every scope whose identity is
  read without running the program.
- There are no other options. No timeout, no schema, no policy switch.

The body is program code, so it cannot itself call a far side. The write happens where it happens
today: in a handler method (the program's own handler behind `ask`, for example) or in the agent
that answers an `ask`. `once` changes how the dispatch of that step recovers, and nothing else.

The table entry in `packages/lang/src/primitives.ts`:

```ts
once: {
  kind: null,
  nameRequired: true,
  options: ["name"],
  optionsAt: 1,
  hashedOptions: [],
  hashesSubject: false,
  opensScope: true,
  signature: "once(fn, { name }) -> value",
  doc: "Run fn so that each step inside it is dispatched at most once. A resume that finds a step begun and never settled does not dispatch it again: it opens a hold, a checkpoint under a token derived from the step's recorded request id, and the settler's answer becomes the step's result. fn returns what the program reads; a write from it to a binding outside it is refused (L2032). Only ask runs inside it; any other effect is refused before it begins (L4028).",
  example: 'const r = await once(async () => await ask(publisher, { name: "publish", schema: { commentId: "number" } }), { name: "publish-360" })',
},
```

`EFFECT_KINDS` does not change. `once` writes a scope entry, like `parallel`, `race` and `fanOut`,
and calls no handler method of its own.

### 3.3 What is hashed

The projection is `{ kind, name }`, the one `parallel`, `race` and `fanOut` use. The body's steps
hash their own inputs as they do anywhere else.

## 4. Semantics

### 4.1 The scope

- `once` opens a scope frame of kind `once` with the single branch `in`, so a step inside it is keyed
  `/once:<name>#<occurrence>/b:in/<kind>:<step>#<n>`. Nesting composes: a step is at-most-once when
  any frame on its scope path has kind `once`.
- It writes one scope entry of kind `once`, begun before `fn` runs and settled with
  `{ branches: ["in"], value }` (spec/cotal-lang.md §10.6). A settled `once` is delivered from its
  own entry without entering the body, like every settled scope (§10.7). The absence rule follows
  `conclave`, which also settles one body's own value: a body that returns nothing settles with
  `value` absent, and a returned value is otherwise crossable whole, so a record with an
  `undefined` field is refused at the settle (L4000) and in a loaded seed (L5024).
- It raises the branch-write depth as a branch of `parallel` does (§7.7), though nothing runs beside
  it. A settled `once` is delivered without entering `fn`, so a write from `fn` to a binding declared
  outside it, or into a record or array born outside it, would happen on the live run and not on a
  resume, and the resumed run would read the old value and take a path it never recorded, with no
  divergence to catch it. Such a write is refused (L2032), statically where the validator can follow
  `fn` and at run time otherwise. `fn` reads the enclosing bindings freely and returns what the
  program needs from it.
- A body that throws fails the scope with that error, as `conclave` does. A cancellation, a host
  release (L5012), a held run (L5025), a refused append (L5010, L5006) and a divergence (L5001)
  travel through it unchanged.

### 4.2 The recovery rule

This is the whole of the new behavior, and it lives in one place, `performEffect`, which both engines
call.

At a step whose scope path contains a `once` frame:

| Lookup verdict | Today | Under `once` |
| --- | --- | --- |
| `miss` | dispatch | dispatch (never started) |
| `refused` | dispatch as a fresh attempt | dispatch as a fresh attempt (never attempted, §10.7) |
| `replay`, `replay-failed`, `replay-cancelled` | return or throw the record | unchanged |
| `diverged` | L5001 | unchanged |
| `pending` | dispatch again under the recorded id | **hold**, never dispatch |

`once` admits one effect kind, `ask`. An `ask` is where a program's write happens: in the
program's own handler behind it, or in the agent that answers it. It calls its handler method once
per activation through `performEffect`, its result is a record a settler can supply, and once the
hold opens nothing its first dispatch left behind settles the step except through the hold: the
open attempt's pause is ended (§6.1), and the agent its attempt was relayed to answers the hold
only with an operator's reach (§4.3). Every other effect kind is refused under `once` with L4028 (an
effect `once` does not admit) before its entry begins, for one of three reasons.

It calls a handler method more than once at one key, so a hold cannot bound it:

- A `checkpoint`. A held one would call `handler.checkpoint` again at its own key to open the hold,
  the method the step itself dispatched, and one with `onExpiry: "escalate"` calls it a second time
  after the first expires, as attempt 1 under a new id it records with `Journal.reissueAs`.
- A `waitUntil`. `performWaitUntil` calls `handler.observe` once per observation at one key, and
  its entry stays `pending` between observations, so a resume observes again.
- A `conclave`. `runScope` calls `handler.openConclave` and `handler.closeConclave` outside
  `performEffect`, and a resume of its `pending` entry calls both again.

Its handler method builds run state that a later step or a migration reads, so a settler's answer
cannot stand in for it:

- A `spawn`. `MeshHandler.spawn` registers the seat in the run's roster and as its worktree's
  holder from the handle it returns.
- A `turn`. `MeshHandler.turn` writes the scope's handoff memo from a handoff result.
- A `monitor`. `MeshHandler.monitor` adds the agent to the monitored set a `wait(down)` reads.
- A `notify`. `MeshHandler.notify` files one notice per addressee under the request id and returns
  `null`. The addressee's next `turn` renders the unconsumed notices filed for it, and `classify` in
  `migrate.ts` rejects a `notify` with no filed notice (L5013). A hold that settled a `notify` would
  file nothing, so the next turn would render no notice and a migration would refuse the run.

Adoption rebuilds the same state from the journal (`seedRunMemos`), so a held `spawn` settled with
the right handle would leave the live process without the roster entry: the next `turn` on that
seat fails not-in-roster, and a second adoption of the same journal succeeds.

It writes nothing for a hold to bound, and its first dispatch holds what only its own ending ends:

- A `sleep`, whose pause under the recorded id is the whole step.
- A `wait`, which on a channel also owns a durable consumer that only its own match or timeout, or a
  cancelled loser's discharge, closes (`MeshHandler.wait`, `MeshHandler.discharge`). Once its entry
  settles, `RunScopeAuthority` refuses the close, so a hold that settled it would leave a consumer
  nothing reads.

The admitted kind is a closed list, `HOLDABLE_KINDS` (§6), so an effect kind added later is refused
under `once` until it is listed. No entry begins, no handler method is called, and a resume reaches
the same refusal. A program that needs an approval, a poll, a conclave, a seat, a turn, a notice or
a pause around its write does it outside the `once` that wraps the write. Outside `once` every kind
is unchanged.

### 4.3 The hold

On a `pending` verdict under `once`, after the existing cancellation check and host-stop check
(`shouldStop`, L5012) and the effect ceiling (L4009), all of which apply as they do to any dispatch:

1. The kind's handler method is **not** called.
2. The interpreter calls `handler.checkpoint(req, ctx)` with
   - `req = { prompt }`, where `prompt` is fixed text naming the step key and the recorded request
     id, and saying the outcome is unknown and the answer becomes the step's result. No `schema`,
     `timeout`, `onExpiry` or `to`: the host's default checkpoint timeout applies.
   - `ctx.key` = the held step's key, `ctx.requestId` = the **hold id**,
     `holdRequestId(recorded)`, and `ctx.attempt` = 0. `recorded` is the entry's recorded
     `requestId`; an entry written before request ids were recorded uses the re-derived id, as
     recovery does today.
   - `ctx.resume` = the hold's own earlier binding (`entry.hold`, §5), absent on the first hold.
   - `ctx.bind(x)` writes `x` to `entry.hold`, never to `entry.external`.
3. On `{ outcome: "resolved", value }` the held entry settles `ok` with `result = value ?? null`,
   and the program continues with that as the step's result. The value answers to the crossing
   rule (spec/cotal-lang.md §4.4) like any result. The hold carries no schema, so the value is not
   checked against the held step's own (an `ask`'s `schema`, say); a program that needs that checks
   the value itself.
4. On `{ outcome: "expired" }` the held entry settles `failed` with
   `{ code: "L4027", kind: "outcome-unknown", message }`, a new catchable code (an at-most-once
   step's outcome was never settled). A program may catch it; a resume replays the failure and
   dispatches nothing.
5. A hold that does not answer never makes the held step look unattempted. The hold has
   `performEffect`'s two failure domains with one change: an `EffectRefused` from the hold's
   `handler.checkpoint` (a host that cannot open a checkpoint, L5016 on the mesh) does **not**
   settle the entry `refused`. `refused` records that the step was never attempted, and that verdict
   dispatches (§4.2), so recording it would turn a refused hold into the second write. The entry
   stays `pending` with the `hold` it had, the run halts with L5025 as any refusal halts it, and the
   next host that can open a checkpoint opens the same hold. A refused append (L5010, L5006) leaves
   the entry as it was, a cancellation settles it `cancelled`, and any other throw settles it
   `failed` under the handler-fault rule (L4000, or the handler's own code). None of these
   dispatches the step again.

A crash while the hold is open leaves the entry `pending` with `hold` set. The next resume takes the
same path, re-derives the same hold id, and the handler re-attaches through `ctx.resume`, as it
re-attaches to any checkpoint today.

What the held step's first dispatch armed is the host's to end, inside the hold's own
`handler.checkpoint` call and before its first bind, so its failure takes the domains above. The
hosted runtime claims the open attempt's pause (§6.1). `SimHandler` arms nothing.

The hosted `ask` also relays each attempt to its seat as a `turn` goal under the attempt's token
(`relayAsk` in `mesh-handler.ts`), and nothing withdraws a relay goal today: the manager serves no
`cancel` for one, and a discharged `ask` leaves its relay as well (#2596). The hold leaves it too,
so the seat may still be shown that turn until it yields or the relay's deadline, the ask's
recorded `deadlineAt`, passes. The relay is one goal per attempt and is never submitted again, so a
write the seat makes in that turn is the first dispatch's one write, and the hold is its only
settle. The seat answers that turn with the command the relay renders,
`cotal run answer <run> <step-key>` (`renderAskRequest` in
`extensions/connector-core/src/agent.ts`), which reads the step's pause as every answer does
(§6.1). Before the hold's first bind that is the claimed attempt pause, which refuses it. After the
bind it is the hold, and the manager refuses the answer of a baseline seat: a baseline seat may
answer only the pause its pending relay names, and this relay names the attempt's token
(`authorizeRunAnswer` in `implementations/manager/src/manager.ts`, unchanged). A seat whose persona
carries the `run` capability has an operator's reach and is not held to its relay, so its answer
lands on the hold as an operator's does, unchecked against the ask's schema (item 3). The hold's
timeout is the host's default checkpoint timeout and is not tied to the relay's deadline, so the
seat can still write after the hold settles or expires. That write is still the one write, and an
expired hold's L4027 says the outcome is unknown, which stays true.

**`holdRequestId(requestId)`** is a new export of `packages/lang/src/keys.ts`, beside `requestId`:
the sha256 of `canonicalize([requestId, "hold"])` in base64url, 43 characters in the endpoint id
alphabet. It is the only definition: the runtime imports it and never re-derives the token itself.

Why a derived id and not the recorded one: an `ask`'s first attempt already armed a one-use pause
under the recorded id, and that pause may already be settled. Minting the hold there would
re-attach to that settle: an `ask` with `attempts: 2` whose first answer was refused would read the
refused answer back as the hold's, and a pause that already expired would expire the hold at once.
The derived id is fresh, and because it is a pure function of the recorded id a resume finds the
same hold without anything recorded before the mint.

The recorded id stays the identity of the write. It is on the entry, the hold's prompt names it,
and `cotal run journal` prints it, so a far side that recorded it (a marker in the comment body, a
header it logs) can settle the hold itself by step key with no human, and a human answering by hand
reads it from the same places.

### 4.4 What does not change

- spawn, turn, ask, checkpoint, sleep, wait, waitUntil, notify, monitor, parallel, race, fanOut and
  conclave keep their signatures, projections and recovery outside a `once` scope.
- A `once` inside a `waitUntil` probe or a `conclave` body is admitted: the wait and the conclave
  are not under its frame, and the steps inside it are at-most-once.
- A hold is an ordinary checkpoint. It is not L5025: the run is parked at a pause, not unwound.
- The language version does not change. No existing program changes meaning except one that binds
  its own `once`, which is refused at validation.

The pause a held `ask`'s first dispatch armed does not outlive the hold: the hosted handler claims
it before the hold's first bind (§6.1). Its relay to the seat can outlive the hold, and the seat's
answer to it reaches the hold only when the seat has an operator's reach (§4.3). An answer
addressed to the step lands on the hold, and an amendment and the journal row of a held step read
the hold's pause (§6.1).

## 5. The step journal

What is recorded **before dispatch** does not change, and it is already enough:

- `begin` appends `pending` with `requestId` and `attempt`, awaited before the handler is called.
- The entry's `scope` string is the key's scope path, so it carries the `once` frame.

From the journal alone, then: no entry means never started (dispatch); a `pending` entry under a
`once` frame means dispatched or about to be, outcome unknown (hold); a settled entry is replayed.
The gap between `begin` landing and the handler's write reaching the far side is classified unknown.
That is the conservative direction, and it is deliberate: the journal cannot see inside a handler,
and the settle is what resolves it.

Added:

- **`JournalKind`** gains the scope kind `once` (`ScopeKind` in `packages/lang/src/keys.ts`).
- **`SCOPE_KINDS`** in `packages/lang/src/journal.ts`, the seed check's own list of kinds whose
  `result` is a scope assembly, gains `once`. Without it a seed carrying a settled `once` whose
  body returned nothing (`{ branches: ["in"], value: undefined }`, as `Journal.entries()` hands it
  to the next `Journal`) is read as an effect result and refused (L5024). `ASSEMBLING_SCOPES` in
  `packages/lang/src/values.ts` does not gain it, as it does not hold `conclave`, so the value
  below the top level stays strict (§4.1).
- **`JournalEntry.hold`**, optional record: the hold's own binding. Written only by the new
  `Journal.hold(key, external)`, which mirrors `Journal.bind` (pending entries only, crossable
  values only, durable before visible). It is a separate field so the first attempt's `external`
  stays on the entry for the settler and for a handler that reads it.
- The seed check (`Journal` constructor) refuses an entry whose `hold` is not crossable (L5024),
  as it does for `external`; `RecordedField` gains `hold`.
- An entry with `hold` set is a held step. `state` and `status` keep their vocabulary.
- The hold id is not recorded. Both the interpreter and the runtime compute it from the entry's
  `requestId` with `holdRequestId`, which is what makes the hosted authority below journal-derived.

On the wire (SPEC.md §14.4) the step record carries the entry verbatim, so the envelope does not
change.

## 6. The interpreter, the engines, the simulator, the dry run

- **`packages/lang/src/primitives.ts`**: the table entry above, which `RESERVED_NAMES` picks up,
  and `HOLDABLE_KINDS` beside `EFFECT_KINDS`: `ask` alone (§4.2). It is
  not exported from the package index; only the interpreter reads it.
- **`packages/lang/src/keys.ts`**: `ScopeKind` adds `once`; `holdRequestId` (§4.3), exported from
  the package index.
- **`packages/lang/src/grammar.ts`**: the validator reads the table, so the name, literal and
  closed-bag checks come from it. The captured-write check (L2032) walks `once`'s body, the thunk at
  index 0, as it walks the branches of `parallel`, `race` and `fanOut`. At run time a first
  argument that is not a function is refused before the scope entry begins, with L4011, the code
  for calling a value that is not a function.
- **`packages/lang/src/perform.ts`**:
  - `performScope` hashes `once` with the `{ kind, name }` projection it uses for `parallel` (no
    subject). The walker's `callScope` and the engine's scope seam reach it as they reach the other
    scopes; `dispatchPrimitive` never sees a scope.
  - `runScope` gains a `once` arm: one branch `in`, `fn` called with no arguments in that branch's
    frame, the clock joined, `{ branches: ["in"], value }` returned. It shares `conclave`'s body
    handling minus the open and the close.
  - `performEffect`: the `pending` case under a `once` frame calls the new `performHold` instead of
    `perform`. `performHold` does §4.3 and nothing else. Its catch is `performEffect`'s minus the
    `refused` settle (§4.3, 5).
  - The L4028 refusal (§4.2): `dispatchPrimitive` makes one test before its `switch`, refusing a
    primitive whose `kind` is neither null nor in `HOLDABLE_KINDS` when the frame's path
    (`frame.keys.path`) has a `once` frame, so no arm reaches `performEffect` or `performWaitUntil`
    for a refused kind; `performScope` refuses kind `conclave`, testing `scopeKey.scope` before its
    lookup. Every arm's live and recovery body is untouched.
  - The "inside once" test is one exported predicate over a key's scope path,
    `atMostOnce(scope)`, true when any frame has kind `once`. `performEffect`, `performScope` and
    the runtime's authority call it with a key's `scope`, and `dispatchPrimitive` with the frame's
    path, so neither engine carries a flag of its own.
- **`packages/lang/src/interpret.ts`** (walker, version 1) and **`packages/lang/src/engine/frame.ts`**
  (compiled engine, version 2): no change. `Frame.branch` and `EngineFrame.branch` raise the depth
  for every kind but `conclave`, which is the rule `once` takes (§4.1), so the runtime half of L2032
  refuses a captured write inside `once` on both engines.
- **`packages/lang/src/engine/ctx.ts`** (compiled engine, version 2): admits `once` where it admits
  the other scopes, its body at index 0 being a function value as `parallel`'s branches are, so the
  emitter's deferral rule (`transform/emit.ts`, bodies at index 1) is untouched.
- **`packages/lang/src/effects.ts`**: no new method on `EffectHandler`. The `EffectContext.resume`
  comment gains one sentence: a step inside `once` is never re-dispatched with it, it holds.
- **`packages/lang/src/errors.ts`**: L4027 in the catalog, catchable. L4028 in the catalog, a
  program fault like L4011, whose message names the refused kind and the `once` it is under.
- **`packages/lang/src/sim.ts`**: no code change. A hold reaches `SimHandler.checkpoint`, which
  scripts by step name, so `checkpoints: { publish: { status: "resolved", value: { commentId: 1000 } } }`
  answers the hold of the `ask` named `publish`, and `{ status: "expired" }` produces L4027. The
  `SimScript.checkpoints` comment says so.
- **`packages/lang/src/dryrun.ts`**: a dry run is a fresh run, so it never meets a pending entry and
  never shows a hold. `PlannedEffect` gains `atMostOnce: true` for a step inside `once`, and
  `renderReport` marks it, because each one is a pause a human may be asked to settle if the host
  dies during it.

### 6.1 The hosted runtime (`@cotal-ai/runtime`)

A hold reaches the hosted handler as a `checkpoint` call whose `ctx.requestId` is the hold id. Every
check below derives the hold from the run's journal: the entry at `ctx.key` is pending, its key is
`atMostOnce`, and the hold id is `holdRequestId(entry.requestId)`. The pause checks also require
`hold` to be set, which the hold's bind does before its mint. Nothing is taken from the caller's
word, and the run's existing ownership, lease and cleanup checks apply unchanged.

- **`MeshHandler.checkpoint`** does not change. It mints under `ctx.requestId`, which is the hold
  id, and binds through `ctx.bind`, which the hold routes to `entry.hold`.
- **`MeshHandler.endPause(entry)`**, a new method holding the pause arm of `MeshHandler.discharge`
  (claim the kind's armed pauses; for a `wait`, also close its consumer), which `discharge` then
  calls for each loser instead of carrying the arm inline. For an `ask` it claims the current
  attempt's pause: `askToken`, or the request id before the first bind. It leaves the attempt's
  relay goal as the discharge does (§4.3).
- **`RunScopeAuthority.effect`** (`run-scope-authority.ts`) also accepts the hold: kind
  `checkpoint`, a pending entry of any kind at `ctx.key` that is `atMostOnce`, not owed to a
  cleanup, `ctx.requestId === holdRequestId(entry.requestId)` and `ctx.attempt === 0`. Today it
  requires the entry's own kind, id and attempt, so a hold on an `ask` is refused before it
  opens.
- **`createRunEffectHost`'s `dispatch`** (`run-effect-host.ts`) resumes a hold from `entry.hold`
  and verifies a hold's bind against `entry.hold`; today it resumes and verifies every call against
  `entry.external`. It knows a hold by the same id comparison. On a hold whose entry has no `hold`
  yet, it calls `handler.endPause(entry)` before `handler.checkpoint`. The entry is still pending
  and the attempt's token is one `pauseTokens` grants it, so the claim is authorized as a cancelled
  loser's is. The claim returns at once for a pause that is settled or was never minted
  (`createRunPauseHost`'s `claim`), so a crash before the attempt armed, or during the claim, leaves
  `hold` unset and the next resume claims again. After it the attempt's pause answers nothing, so
  the hold is the step's only open pause.
- **`pauseTokens`** (`run-scope-authority.ts`), which authorizes every pause operation and feeds
  `rearmTokens`: an entry with `hold` set also owns `holdRequestId(entry.requestId)`, whatever its
  kind, beside the tokens its kind owns today.
- **`outstandingPauseTokens`** (`mesh-handler.ts`), the adoption re-arm: adds the hold id of every
  pending entry with `hold` set. It still lists the attempt's token the hold claimed, which re-arms
  nothing, because `reconcileCheckpointSchedule` (`packages/core/src/endpoint-checkpoint.ts`)
  re-emits a schedule only for a waiting pause.
- **`MeshHandler.discharge`**: a cancelled loser with `hold` set has its hold id's pause claimed
  beside the per-kind release it gets today.
- **One pause per step for every reader.** Three readers pick the token a step's pause is read
  under, and each picks the kind's own today (an `ask`'s last `askToken`, otherwise the request id):
  `openCheckpointToken` (`cotal run answer`) and `settledPauseToken` (behind `locateAcceptedAnswer`,
  so `cotal run amend`) in `resolve-checkpoint.ts`, and `journalRows` (`cotal run journal`'s
  accepted answer and amendments) in `run-host.ts`. All three take it from one new function in
  `resolve-checkpoint.ts`, `stepPauseToken(records)`, over the step's records in append order: a
  step any of whose records carries `hold` reads at `holdRequestId(requestId)` whatever its kind, and
  every other step reads where it does today. All three call it on a pending step as on a settled
  one, and `openCheckpointToken` and `settledPauseToken` test for a held step before their
  `not-a-checkpoint` refusal. Between the claim and the hold's first bind no record carries `hold`,
  so the step still reads at the attempt's token, whose pause is no longer waiting, and an answer
  presented there is refused, never applied. So `cotal run answer <run> <step-key> --value <json>`
  settles a held step, `cotal run journal` prints the hold's accepted answer (its
  id, value, `by` and artifact) and the amendments filed under the hold id, and `cotal run amend`
  supersedes the hold's answer. An answer the first attempt's pause accepted before the crash,
  conforming or not, is never shown as the step's: it stays on that pause, and the entry keeps
  `external` as the write's evidence.
- **`cotal run journal`** (`journalStepRow` in `run-host.ts`) reads `asks`, `deadlineAt` and
  `onExpiry` from `hold` when it is set, so it prints the hold's question. `hold` carries them
  because it is what `MeshHandler.checkpoint` binds; an `ask`'s own `external` carries none of
  them.
- **`planFork`** (`fork.ts`) admits a cut inside `once` as it admits one inside `parallel` or
  `fanOut`, at both of its gates: its one branch runs, so the parent decided nothing the child
  re-decides. `SCOPE_KINDS`, the kinds whose entry can enclose a cut, gains `once`, so the
  enclosing entry is projected out of the cut. The re-entry gate after that projection, which
  refuses with L5020 every enclosing kind but `parallel` and `fanOut`, admits `once` beside them.
  With the first change alone the cut is refused L5020; with neither, the enclosing `once` is
  copied settled and the child replays it without reaching the step it was forked to re-run. The
  child's steps carry the child's run id, so its dispatch of the cut step is the fork the operator
  asked for.
- **`classify`** in `migrate.ts`, the orphan table, lists `once` beside `parallel`, `race` and
  `fanOut`: a scope that outlives nothing of its own. Its default refuses an unlisted kind (L5015),
  so without the row every migration of a run that entered `once` is refused. spec/cotal-lang.md
  §11.2 gains the same row (§7).
- Who may answer does not change. Answering a hold goes through `resolveCheckpoint` and the run's
  own ACL, the path every checkpoint and `ask` answer takes, so whoever may answer a pause of the
  run may settle a hold, and nobody else. That is an operator, or a seat whose persona carries the
  `run` capability. A baseline seat answers only the pause its pending relay names
  (`authorizeRunAnswer`), and no relay names a hold id, because the hold is minted at attempt 0
  with no `to` and relays nothing. So a baseline seat never settles a hold, including the seat the
  held `ask` was relayed to (§4.3). The request id in the prompt is the identity already on the
  pending entry and in `cotal run journal`; it is not a credential.

## 7. Normative text, insertion-only

Each block below is inserted verbatim; no existing sentence is edited or removed. Every closed list
of scopes or entry kinds in spec/cotal-lang.md gains `once` here, because a list that omits it
states a refusal the implementation no longer makes.

**spec/cotal-lang.md §2**, after the L2013 bullet: the concise body of an arrow passed to `once`
(§7.8) is admitted the same way, since `once` owns its body as the other scopes own their branches.

**§6.1**, a row after `conclave`:

```
| `once` | `once(fn, { name }) -> value` | scope `once` | required |
```

**§6.4**, a row after the `parallel`, `race`, `fanOut` row:

```
| `once` | `{ kind, name }` |
```

**§6.5**, after "The four scopes are §7.": `once` is the fifth (§7.8).

**§7**, after its first paragraph: `once` (§7.8) is a fifth scope. It opens a scope frame and
writes one entry like the other four, and runs its one branch with nothing beside it.

**§7.7**, at the end of its first paragraph: `once` raises the depth like a branch of `parallel`,
though nothing runs beside it, because a settled `once` is replayed without entering its body
(§7.8), so a write from the body would happen live and never on resume.

**§7.8 `once`**, a new subsection after §7.7:

> `once(fn, { name })` runs `fn` as the single branch `in` and settles with its value. Every step
> whose scope path contains a `once` frame is **at-most-once**: an implementation MUST NOT dispatch
> it twice, where a dispatch is a call of the step's handler method under the step's recorded
> request id that does not end in a refusal. A refused call performed nothing, so its step
> dispatches again as a fresh attempt; retries a handler performs inside one call are not
> dispatches, and neither are the hold's own calls, which run under the hold id. Under a `once`
> frame only `ask` may run, and every other effect MUST be refused before its entry begins, with
> L4028. A `checkpoint`, a `waitUntil` and a `conclave` call a handler method more than once at one
> key (a hold is itself a checkpoint, one observation per look, an open and a close that a resume
> calls again). A `spawn`, a `turn`, a `monitor` and a `notify` build run state inside that method
> (a seat, a handoff, a watched agent, a filed notice), which a settled answer cannot build. A
> `sleep` and a `wait` write nothing to bound, and their first dispatch holds a pause or a durable
> consumer that only their own ending ends. A resume that finds an
> at-most-once step `pending` MUST NOT call its handler method; it opens a **hold** instead, a
> checkpoint whose request carries only a prompt, dispatched at attempt 0 under the **hold id**,
> the sha256 of the canonical form of `[<recorded request id>, "hold"]` in base64url, whose
> binding is written to the entry's `hold` field and never to `external`. Before the hold's first
> bind the host MUST end the pause the step's first dispatch armed, so the hold is the step's only
> open pause; an answer, an amendment or a journal view addressed to a step whose entry carries
> `hold` MUST read the hold id's pause, never the one the first dispatch armed. A
> resolved hold settles the step `ok` with the answered value (`null` when none). An expired hold
> settles it `failed` with L4027, kind `outcome-unknown`, which a program may catch and a resume
> replays. A hold the host refuses MUST leave the step `pending`,
> never `refused`, and halts the run (L5025), so the next capable host opens the same hold; a
> cancelled hold settles the step `cancelled`, a failed one settles it `failed`, and neither is
> dispatched again. A `miss` and a `refused` verdict dispatch as they do anywhere, because a step
> with no `pending` entry was never started. `once` raises the depth like a branch of `parallel`
> (§7.7): a settled `once` is replayed without entering `fn`, so `fn` MUST NOT write to a binding
> declared outside it or into a record or array born outside it (L2032), and returns what the
> program reads instead. `once` bounds the number of dispatches; it does not make a far side's
> write exactly-once.
>
> ```js
> const publisher = await spawn("publisher")
> const res = await once(async () => {
>   return await ask(publisher, { name: "publish", schema: { commentId: "number" } })
> }, { name: "publish-360" })
> log("comment", res.commentId)
> ```

**§10.1**, in the entry's `kind` comment, `| once` after `conclave`. After the description of
`external`: an entry MAY carry `hold`, the binding of the hold opened for an at-most-once step
(§7.8); it answers to the crossing rule like `external`, and a resume refuses a loaded `hold` that
fails it (L5024).

**§10.4**, at the end: a hold (§7.8) is dispatched under the hold id derived from the recorded id of
the step it holds, never under that id itself, because the step may already have armed and settled
a pause there; the step's own id and attempt do not change.

**§10.6**, after the sentence on what a `conclave` settles: a `once` settles its body's own value
the same way, so only a body that produced no value at all is absence; it records no `closed`.

**§10.7**, after the verdict list: under a `once` frame (§7.8) the **pending** verdict opens a hold
instead of re-binding.

**§11.2**, a row after the `parallel`, `race`, `fanOut` row:

```
| `once` | ignored: a scope outlives nothing of its own |
```

**Appendix A**, two rows: `| L4027 | At-most-once step's outcome was never settled |` and
`| L4028 | Effect not admitted inside \`once\` |`.

**Appendix B**, a row for the date the implementation lands, naming §7.8, the `hold` field, L4027
and L4028.

**SPEC.md §13.8**, at the end of the **Idempotency scope** bullet:

> A workflow step inside a `once` scope (`spec/cotal-lang.md` §7.8) is dispatched at most once per
> step key whatever the far side honors, a dispatch being one call of its handler under its request
> id that the handler does not refuse (the handler may retry inside that call): a resume that finds
> it begun and unsettled opens a hold
> under a token derived from its recorded request id instead of dispatching it again, trading the
> run's liveness for the bound.

**SPEC.md §14.5**, after the `answer` bullet:

> A held `once` step (`spec/cotal-lang.md` §7.8) is answered like a checkpoint, addressed by its step
> key; the driver presents the hold id (`spec/cotal-lang.md` §7.8) as the token, whatever kind the
> step is, and reads the step's accepted answer and amendments under the same id once it settles.
> The run's pause authority covers that id only while the step is pending with its hold bound.

Guide pages updated in the same change: `docs/workflows.md` (when to wrap a step in `once`, and
answering a held step with `cotal run answer`) and `packages/lang/README.md` (one line beside
`bind`/`resume`).

## 8. Acceptance

An operator drives these by hand against the implementation before it merges. None becomes a
committed test.

### 8.1 Simulator, both engines

A node script over the package's public exports: `run` and `resume`, `Journal` over a JSONL
`JournalStore`, and a `SimHandler` subclass whose `ask` for step `publish` appends one line to an
`external.jsonl` (the write) and records `ctx.requestId`, and whose `spawn` binds the program's
`onFork` beside `simAgent` when it gives one, as `MeshHandler.spawn` binds the policy `planFork`
reads. A crash is `process.exit` inside the handler or the store, in a child process, so it is a
real process death. Program:

```js
const publisher = await spawn("publisher")
const res = await once(async () => {
  return await ask(publisher, { name: "publish", schema: { commentId: "number" } })
}, { name: "publish-360" })
log("comment", res.commentId)
```

Run each case under language version 1 (`run`) and version 2 (`runInWorker`).

1. **Crash between the write and the settle yields a hold, not a second dispatch.** First
   activation exits after the write. Resume with
   `checkpoints: { publish: { status: "resolved", value: { commentId: 1000 } } }`. Expected:
   `ask` called 0 times on resume, `checkpoint` called once with `ctx.key` =
   `/once:publish-360#0/b:in/ask:publish#0`, `ctx.requestId` equal to `holdRequestId` of the id on
   the pending entry and `ctx.attempt` 0, one line in `external.jsonl`, the step settled `ok` with
   `{ commentId: 1000 }`, the run completes. A second resume dispatches nothing.
2. **The hold expires.** Same crash, resume scripted `{ status: "expired" }`. Expected: the step
   settles `failed` L4027, a program that catches it continues, one line in `external.jsonl`, and a
   further resume replays the failure with no dispatch.
3. **A crash during the hold re-attaches.** Exit inside the hold's checkpoint after its bind; resume.
   Expected: `checkpoint` called again under the hold id with `ctx.resume` equal to the hold
   binding, `ask` not called.
4. **A never-started step resumes normally.** The store exits before the `ask`'s `pending` append
   lands. Expected: resume dispatches `ask` once, no hold, one line in `external.jsonl`.
5. **A settled step is not re-dispatched.** Clean run, then resume over the full journal. Expected:
   no handler call on resume, one line in `external.jsonl`, the same result.
6. **The existing primitives are unchanged.** The same program without `once`, case 1's crash:
   resume calls `ask` again under the same `ctx.requestId`, two lines in `external.jsonl`, as
   §10.7 specifies today. Plus `pnpm smoke:lang-surface` and the lang package's existing smoke suites
   green with no edits to them.
7. **A refused call is not a dispatch.** The program above, with an `ask` that throws
   `new EffectRefused("L5016", "no substrate")` on its first three activations and writes on the
   fourth. Expected: three L5025 halts with the entry `refused` after each, four `ask` calls, no
   hold and no `checkpoint` call, one line in `external.jsonl`, the step settled `ok`.
8. **An effect `once` does not admit is refused inside it.** With `publisher` spawned
   before it, `await once(async () => <call>, { name: "inner" })` for each of
   `checkpoint("publish", "write it", { onExpiry: "proceed" })`,
   `checkpoint("publish", "write it", { onExpiry: "escalate", to: "operator" })`,
   `waitUntil(probe, { name: "read", every: "1s", deadline: "1m", terminal: (o) => o === 2 })`
   whose probe answers 1 then 2, a `conclave` of `[publisher]`, `spawn("helper")`,
   `turn(publisher, { name: "t" })`, `monitor(publisher, { name: "m" })`,
   `notify([publisher], { decision: "ship", outcome: "posted" }, { name: "tell" })`,
   `sleep("1ms", { name: "s" })` and `wait(message(channel("events")), { name: "w", timeout: "1s" })`,
   with each handler method appending to `external.jsonl`. Expected for each: L4028 naming the
   kind, no handler method called, no entry under `/once:inner#0`, nothing in `external.jsonl`, and
   a resume reaches the same refusal. The same calls outside `once` behave as today: the escalating
   checkpoint makes two calls at one key, attempts 0 and 1, and the `waitUntil` two `observe` calls
   at `/waitUntil:read#0`, attempts 0 and 1.
9. **A captured write is refused, and the returned value has live and resume parity.** The program
   `const state = { count: 0 }; let n = 0; await once(async () => { state.count = 1; n = 2 }, { name: "write" }); log(state.count, n)`
   is refused with L2032 at validation on both engines, and the same writes made through a helper
   the validator cannot follow are refused with L2032 at run time on both. The program
   `const r = await once(async () => ({ count: 1, n: 2 }), { name: "write" }); log(r.count, r.n); await notify([a], { decision: "d", outcome: "o" }, { name: r.n === 2 ? "after" : "other" })`,
   with `a` spawned before it, logs `1 2` live. Crashed after the `once` settles and before the
   `notify` begins, then resumed: it logs `1 2` again, the `once` body is not entered, and `notify`
   `after` is dispatched once. A `once` nested in a `parallel` branch keeps L2032 for that branch's
   outer bindings on both engines.
10. **A body that returns nothing resumes from its seed.** The program
    `await once(async () => {}, { name: "noop" })`, run to completion, then resumed twice: once with
    the settled run's `Journal.entries()` as the next `Journal`'s seed in the same process, so
    `value: undefined` survives, and once over the JSONL store. Expected: both resumes replay the
    scope without entering the body. A seed whose settled `once` value is a record with an
    `undefined` field is refused with L5024, as `conclave`'s is.
11. **A refused hold does not become a second write.** Case 1's crash, then a resume whose
    handler's `checkpoint` throws `new EffectRefused("L5016", "checkpoint substrate unavailable")`.
    Expected: L5025, the `ask` entry still `pending` and not `refused`, `ask` not called, one line
    in `external.jsonl`. Then a resume with case 1's capable handler: `checkpoint` called once
    under the hold id, `ask` not called, one line, the step settled `ok`, the run completes.
12. **A migration ignores an orphaned `once`.** Case 10's program run to completion, then
    `migrateRun` onto the source `log("hi")`: the `once` entry is an orphan with verdict `ignored`,
    as a `parallel` entry is, and the migration is admissible.
13. **A fork inside `once` is admitted.** The program
    `const p = await spawn("publisher", { onFork: "adopt" }); await once(async () => { await ask(p, { name: "before", schema: {} }); return await ask(p, { name: "cut", schema: {} }) }, { name: "write" })`,
    run to completion, then `planFork` from `@cotal-ai/runtime` at
    `/once:write#0/b:in/ask:cut#0`. Expected: admissible with no L5020, and the cut holds the
    `spawn` and `/once:write#0/b:in/ask:before#0` and neither the `once` entry nor `cut`. The child
    resumed from the cut under its own run id replays `before`, calls `ask` for `cut` once with a
    `ctx.requestId` that differs from the parent's, and settles a new `once` entry. The same program
    with `spawn("publisher")` is refused L5019 at `/spawn:publisher#0`, the spawn gate `once` does
    not change.

### 8.2 One hosted run

On a local mesh with a manager. A restarted manager retires the seats of the manager it succeeds:
its static reconcile evicts the crashed predecessor's seat principals and retires their
credentials, so no seat survives a kill. After each restart the operator re-spawns the `publisher`
persona (`cotal spawn publisher`) and drives the post-restart steps from that fresh incarnation. The
hold id is the continuity key. A fresh incarnation holds none of the first attempt's goals and
reaches the step through the run and its step key, which the hold answers under the hold id.

Two refusals in this procedure are distinct. A seat the restart retired is refused before any run
check, as a retired credential: `the caller's lifecycle is retired`. A live seat without the `run`
capability is refused by the baseline relay authorization, because a held `ask` settles only with
an operator's reach (§4.3). Step 4 exercises both.

1. `cotal run start --file publish.cotal.js` with the program above followed by
   `const fresh = await spawn("publisher")` and `await turn(fresh, { name: "after" })`, where a
   `publisher` seat's answer to `publish` appends one line to a file outside the run and then
   answers. The `publisher` persona carries no `run` capability. The `after` turn goes to a seat
   the run spawns after the step settles: a turn wakes only an agent the run spawned, and step 3
   retires the one it spawned first.
2. When the line appears, kill the manager process (SIGKILL) before the answer is accepted.
3. Restart the manager. It takes the run back from the journal and retires the original seat.
   Re-spawn the `publisher` persona.
4. Expected: `cotal run journal <run>` shows `/once:publish-360#0/b:in/ask:publish#0` open with the
   hold's question naming the recorded request id; no seat receives a second `publish` turn: the
   restarted manager adopts the first attempt's relay under the recorded id and mints none, and the
   fresh incarnation holds no turn; the file still has one line. The first attempt's pause, read
   with `readCheckpointStatus` at the `askToken` on the step's pending entry, is no longer waiting:
   here it holds no answer, because the hold claimed it. The original seat runs the command its
   first `publish` goal renders with `{"commentId":1000}` and is refused as a retired credential.
   The fresh incarnation runs the same command once with `{"wrong":"shape"}` and once with
   `{"commentId":1000}`: both are refused permission-denied by the baseline relay authorization.
   Nothing is filed under the hold id, and the step stays open.
5. Kill and restart the manager again while the hold is open, and re-spawn the persona. Expected:
   the hold's timer is re-armed under the hold id: the timer stream gains an `.armed` row for the
   hold id at the epoch the restarted manager took the run back under, with the hold's generation
   and deadline, and `cotal run journal` still shows the same question.
6. `cotal run answer <run> "/once:publish-360#0/b:in/ask:publish#0" --value '{"commentId":1000}'`
   from the operator's terminal.
   Expected: the answer is presented under the hold id, the step settles with that value, the
   `after` turn reaches the seat the run spawns next, because a held `ask` builds no run state a
   later step reads, and the run completes. `cotal run journal <run>` prints the step's answer as
   the hold's: its answer id, the value `{"commentId":1000}` and the answerer as `by`.
   `cotal run amend <run> "/once:publish-360#0/b:in/ask:publish#0" --value '{"commentId":1001}'`
   files an amendment whose `supersedes` is that answer id, and the journal lists it under the
   step.
7. Repeat steps 1 to 6 with `attempts: 2`, where the original seat's first answer
   `{ "wrong": "shape" }` does not conform and the manager is killed after that answer is accepted
   and before the second attempt binds. The handler reads a settle on a poll (`awaitSettle`, every
   2 s), so a kill right after `cotal run answer` returns lands in that window. Expected: the hold
   waits for its own answer and does not settle with the refused one, and after step 6 the step's
   value, the printed answer (id, value, `by`) and the amendment's `supersedes` are the hold's,
   never the refused answer or its responder.
8. Repeat steps 1 to 6 where the original seat answers `{ "commentId": 7 }`, which conforms, and the
   manager is killed in the same window after that answer is accepted and before the step settles.
   Expected: the restarted manager opens the hold, and after step 6 the step's value, the printed
   answer and the amendment's `supersedes` are the hold's `{ "commentId": 1000 }`, never the
   `{ "commentId": 7 }` the first attempt's pause holds.
9. Repeat steps 1 to 6 with the `publisher` persona carrying the `run` capability, where no seat
   answers in step 4, and in step 6 the incarnation re-spawned after the second restart runs the
   command the first `publish` goal rendered instead of the operator.
   Expected: the answer is presented under the hold id, the step settles with that value, and
   `cotal run journal <run>` prints that incarnation's name as `by`.

## 9. Out of scope

- Exactly-once for any far side. A far side that honors `ctx.requestId` as an idempotency key needs
  no `once`; the existing `requestId`/`bind`/`resume` contract already gives it exactly-once.
- Automatic settlement by reading the far side. A handler that can look (list comments, match the
  marker) still can; `once` makes that a choice made at the hold, not a convention every handler
  author rebuilds.
- #733 and #734 (abandonment) and #425 (control-plane return values), as the issue says.
