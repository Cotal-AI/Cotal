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
today: in a handler method (the program's own handler behind `ask`, for example) or in an agent's
turn. `once` changes how the dispatch of that step recovers, and nothing else.

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
  doc: "Run fn so that each step inside it is dispatched at most once. A resume that finds a step begun and never settled does not dispatch it again: it opens a hold, a checkpoint under a token derived from the step's recorded request id, and the settler's answer becomes the step's result.",
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
  `conclave`, which also settles one body's own value.
- Like `conclave`, it has one branch and does not raise the branch-write depth (§7.7), so code inside
  `fn` reads and writes the enclosing bindings as if the wrapper were not there.
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

The live path is unchanged: inside one activation a step is dispatched once anyway. The rule only
removes the second dispatch that recovery performs today.

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
5. A held **`checkpoint`** is the one exception to 3 and 4. A checkpoint's recorded result is its
   raw outcome, and its policy is applied after the journal (`applyCheckpointPolicy`, called by the
   `checkpoint` arm of `dispatchPrimitive`). So a held checkpoint settles `ok` with the hold's raw
   outcome as `handler.checkpoint` returned it, resolved or expired, and the program's own
   `onExpiry` decides an expired hold as it decides an expired checkpoint, live and on
   replay. It never fails with L4027, and `escalate` performs no hop: the hold is the step's last
   attempt.

A crash while the hold is open leaves the entry `pending` with `hold` set. The next resume takes the
same path, re-derives the same hold id, and the handler re-attaches through `ctx.resume`, as it
re-attaches to any checkpoint today.

**`holdRequestId(requestId)`** is a new export of `packages/lang/src/keys.ts`, beside `requestId`:
the sha256 of `canonicalize([requestId, "hold"])` in base64url, 43 characters in the endpoint id
alphabet. It is the only definition: the runtime imports it and never re-derives the token itself.

Why a derived id and not the recorded one: every pause kind already armed a one-use pause under the
recorded id (`checkpoint`, `sleep`, `turn`, `wait`, and an `ask`'s first attempt), and that pause
may already be settled. Minting the hold there would re-attach to that settle: an `ask` with
`attempts: 2` whose first answer was refused would read the refused answer back as the hold's, and
a pause that already expired would expire the hold at once. The derived id is fresh for every kind,
and because it is a pure function of the recorded id a resume finds the same hold without anything
recorded before the mint.

The recorded id stays the identity of the write. It is on the entry, the hold's prompt names it,
and `cotal run journal` prints it, so a far side that recorded it (a marker in the comment body, a
header it logs) can settle the hold itself by step key with no human, and a human answering by hand
reads it from the same places.

### 4.4 What does not change

- spawn, turn, ask, checkpoint, sleep, wait, waitUntil, notify, monitor, parallel, race, fanOut and
  conclave keep their signatures, projections and recovery outside a `once` scope.
- `waitUntil`'s own entry keeps re-observing on resume inside `once` (an observation is not a
  write). The steps its probe performs are each at-most-once.
- `conclave`'s open and close keep their own recovery: they run in `runScope`, not `performEffect`.
- A hold is an ordinary checkpoint. It is not L5025: the run is parked at a pause, not unwound.
- The language version does not change. No existing program changes meaning except one that binds
  its own `once`, which is refused at validation.

Placing a `sleep`, `wait` or `turn` inside `once` is legal and holds like anything else, which is
almost never wanted. The guide says to wrap only the step whose handler writes to a far side. A
pause that a held step's first dispatch armed is left as it is: nothing waits on it once the hold
opens, and an answer addressed to the step lands on the hold (§6.1).

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

- **`packages/lang/src/primitives.ts`**: the table entry above. `RESERVED_NAMES` picks it up.
- **`packages/lang/src/keys.ts`**: `ScopeKind` adds `once`; `holdRequestId` (§4.3), exported from
  the package index.
- **`packages/lang/src/grammar.ts`**: the validator reads the table, so the name, literal and
  closed-bag checks come from it. The captured-write check (L2032) skips `once` as it skips
  `conclave`. At run time a first argument that is not a function is refused before the scope entry
  begins, with L4011, the code for calling a value that is not a function.
- **`packages/lang/src/perform.ts`**:
  - `dispatchPrimitive` routes `once` to `runScope` with the `{ kind, name }` projection.
  - `runScope` gains a `once` arm: one branch `in`, `fn` called with no arguments in that branch's
    frame, the clock joined, `{ branches: ["in"], value }` returned. It shares `conclave`'s body
    handling minus the open and the close.
  - `performEffect`: the `pending` case under a `once` frame calls the new `performHold` instead of
    `perform`. `performHold` does §4.3 and nothing else; the `kind` it already has selects the
    checkpoint rule (§4.3, 5), so `dispatchPrimitive`'s `checkpoint` arm and its
    `applyCheckpointPolicy` call are untouched. The "inside once" test is one exported predicate
    over `key.scope`, `atMostOnce(key)`, which the runtime's authority also calls, so neither
    engine carries a flag of its own.
- **`packages/lang/src/interpret.ts`** (walker, version 1): the depth rule treats `once` as it
  treats `conclave`. Everything else arrives through `perform.ts`.
- **`packages/lang/src/engine/ctx.ts`** (compiled engine, version 2): admits `once` where it admits
  the other scopes, its body at index 0 being a function value as `parallel`'s branches are, so the
  emitter's deferral rule (`transform/emit.ts`, bodies at index 1) is untouched.
- **`packages/lang/src/effects.ts`**: no new method on `EffectHandler`. The `EffectContext.resume`
  comment gains one sentence: a step inside `once` is never re-dispatched with it, it holds.
- **`packages/lang/src/errors.ts`**: L4027 in the catalog, catchable.
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
- **`RunScopeAuthority.effect`** (`run-scope-authority.ts`) also accepts the hold: kind
  `checkpoint`, a pending entry of any kind at `ctx.key` that is `atMostOnce`, not owed to a
  cleanup, `ctx.requestId === holdRequestId(entry.requestId)` and `ctx.attempt === 0`. Today it
  requires the entry's own kind, id and attempt, so a hold on an `ask`, `notify` or `spawn` is
  refused before it opens.
- **`createRunEffectHost`'s `dispatch`** (`run-effect-host.ts`) resumes a hold from `entry.hold`
  and verifies a hold's bind against `entry.hold`; today it resumes and verifies every call against
  `entry.external`. It knows a hold by the same id comparison.
- **`pauseTokens`** (`run-scope-authority.ts`), which authorizes every pause operation and feeds
  `rearmTokens`: an entry with `hold` set also owns `holdRequestId(entry.requestId)`, whatever its
  kind, beside the tokens its kind owns today. The `wait` rule that a mint or heartbeat names a
  recorded wait timer applies to the wait's own tokens, not to its hold id.
- **`outstandingPauseTokens`** (`mesh-handler.ts`), the adoption re-arm: adds the hold id of every
  pending entry with `hold` set.
- **`MeshHandler.discharge`**: a cancelled loser with `hold` set has its hold id's timer cancelled,
  before the per-kind release it gets today (which still despawns a held `spawn`'s seat and
  withdraws a held `notify`'s notices).
- **`openCheckpointToken`** (`resolve-checkpoint.ts`): an entry with `hold` set answers with its
  hold id whatever its kind, checked before the kind test, so `cotal run answer <run> <step-key>
  --value <json>` settles a held step and never reaches the pause its first dispatch armed.
- **`cotal run journal`** (`journalStepRow` in `run-host.ts`) reads `asks`, `deadlineAt` and
  `onExpiry` from `hold` when it is set, so it prints the hold's question.
- Who may answer does not change. Answering a hold goes through `resolveCheckpoint` and the run's
  own ACL, the path every checkpoint and `ask` answer takes, so whoever may answer a pause of the
  run may settle a hold, and nobody else. The request id in the prompt is the identity already on
  the pending entry and in `cotal run journal`; it is not a credential.

## 7. Normative text, insertion-only

Each block below is inserted verbatim; no existing sentence is edited or removed.

**spec/cotal-lang.md §6.1**, a row after `conclave`:

```
| `once` | `once(fn, { name }) -> value` | scope `once` | required |
```

**§6.4**, a row after the `parallel`, `race`, `fanOut` row:

```
| `once` | `{ kind, name }` |
```

**§7.8 `once`**, a new subsection after §7.7:

> `once(fn, { name })` runs `fn` as the single branch `in` and settles with its value. Every step
> whose scope path contains a `once` frame is **at-most-once**: an implementation MUST NOT dispatch
> it twice. A resume that finds such a step `pending` MUST NOT call its handler method; it opens a
> **hold** instead, a checkpoint whose request carries only a prompt, dispatched at attempt 0 under
> the **hold id**, the sha256 of the canonical form of `[<recorded request id>, "hold"]` in
> base64url, whose binding is written to the entry's `hold` field and never to `external`. A
> resolved hold settles the step `ok` with the answered value (`null` when none). An expired hold
> settles it `failed` with L4027, kind `outcome-unknown`, which a program may catch and a resume
> replays. A held `checkpoint` instead settles `ok` with the hold's raw outcome, resolved or
> expired, so its own `onExpiry` applies. A `miss` and a `refused` verdict dispatch as they do
> anywhere, because a step with no `pending` entry was never started. Like `conclave`, `once` has
> one branch and does not raise the depth. `once` bounds the number of dispatches; it does not make
> a far side's write exactly-once.
>
> ```js
> const publisher = await spawn("publisher")
> const res = await once(async () => {
>   return await ask(publisher, { name: "publish", schema: { commentId: "number" } })
> }, { name: "publish-360" })
> log("comment", res.commentId)
> ```

**§10.1**, after the description of `external`: an entry MAY carry `hold`, the binding of the hold
opened for an at-most-once step (§7.8); it answers to the crossing rule like `external`, and a resume
refuses a loaded `hold` that fails it (L5024).

**§10.4**, at the end: a hold (§7.8) is dispatched under the hold id derived from the recorded id of
the step it holds, never under that id itself, because the step may already have armed and settled
a pause there; the step's own id and attempt do not change.

**§10.7**, after the verdict list: under a `once` frame (§7.8) the **pending** verdict opens a hold
instead of re-binding.

**Appendix A**, a row: `| L4027 | At-most-once step's outcome was never settled |`.

**Appendix B**, a row for the date the implementation lands, naming §7.8, the `hold` field and L4027.

**SPEC.md §13.8**, at the end of the **Idempotency scope** bullet:

> A workflow step inside a `once` scope (`spec/cotal-lang.md` §7.8) is dispatched at most once per
> step key whatever the far side honors: a resume that finds it begun and unsettled opens a hold
> under a token derived from its recorded request id instead of dispatching it again, trading the
> run's liveness for the bound.

**SPEC.md §14.5**, after the `answer` bullet:

> A held `once` step (`spec/cotal-lang.md` §7.8) is answered like a checkpoint, addressed by its step
> key; the driver presents the hold id (`spec/cotal-lang.md` §7.8) as the token, whatever kind the
> step is, and the run's pause authority covers that id only while the step is pending with its
> hold bound.

Guide pages updated in the same change: `docs/workflows.md` (when to wrap a step in `once`, and
answering a held step with `cotal run answer`) and `packages/lang/README.md` (one line beside
`bind`/`resume`).

## 8. Acceptance

An operator drives these by hand against the implementation before it merges. None becomes a
committed test.

### 8.1 Simulator, both engines

A node script over the package's public exports: `run` and `resume`, `Journal` over a JSONL
`JournalStore`, and a `SimHandler` subclass whose `ask` for step `publish` appends one line to an
`external.jsonl` (the write) and records `ctx.requestId`. A crash is `process.exit` inside the
handler or the store, in a child process, so it is a real process death. Program:

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
   Expected: `checkpoint` called again with `ctx.resume` equal to the hold binding, `ask` not called.
4. **A never-started step resumes normally.** The store exits before the `ask`'s `pending` append
   lands. Expected: resume dispatches `ask` once, no hold, one line in `external.jsonl`.
5. **A settled step is not re-dispatched.** Clean run, then resume over the full journal. Expected:
   no handler call on resume, one line in `external.jsonl`, the same result.
6. **The existing primitives are unchanged.** The same program without `once`, case 1's crash:
   resume calls `ask` again under the same `ctx.requestId`, two lines in `external.jsonl`, as
   §10.7 specifies today. Plus `pnpm smoke:lang-surface` and the lang package's existing smoke suites
   green with no edits to them.
7. **A held checkpoint keeps its own contract.** The program
   `const c = await once(async () => await checkpoint("approve", "post it?", { onExpiry: "proceed" }), { name: "approve-360" })`,
   with a `checkpoint` that appends to `external.jsonl` and exits on the first activation. Resume
   scripted `{ status: "resolved", value: { approved: true } }`: `c.status` is `resolved` and
   `c.value` is `{ approved: true }`. Resume scripted `{ status: "expired" }`: `c.status` is
   `expired`, and the same program with no `onExpiry` throws L4007. A further resume replays each
   result with no dispatch.

### 8.2 One hosted run

On a local mesh with a manager:

1. `cotal run start --file publish.cotal.js` with the program above, where the `publisher` seat's
   answer to `publish` appends one line to a file outside the run and then answers.
2. When the line appears, kill the manager process (SIGKILL) before the answer is accepted.
3. Restart the manager. It takes the run back from the journal.
4. Expected: `cotal run journal <run>` shows `/once:publish-360#0/b:in/ask:publish#0` open with the
   hold's question naming the recorded request id; the seat receives no second `publish` turn; the
   file still has one line.
5. Kill and restart the manager again while the hold is open. Expected: the hold's timer is
   re-armed under the hold id, and `cotal run journal` still shows the same question.
6. `cotal run answer <run> "/once:publish-360#0/b:in/ask:publish#0" --value '{"commentId":1000}'`.
   Expected: the answer is presented under the hold id, the step settles with that value and the
   run completes.
7. Repeat steps 1 to 4 with `attempts: 2`, where the seat's first answer does not conform and its
   second appends the line before the kill. Expected: the hold waits for its own answer; it does not
   settle with the refused first answer.

## 9. Out of scope

- Exactly-once for any far side. A far side that honors `ctx.requestId` as an idempotency key needs
  no `once`; the existing `requestId`/`bind`/`resume` contract already gives it exactly-once.
- Automatic settlement by reading the far side. A handler that can look (list comments, match the
  marker) still can; `once` makes that a choice made at the hold, not a convention every handler
  author rebuilds.
- #733 and #734 (abandonment) and #425 (control-plane return values), as the issue says.
