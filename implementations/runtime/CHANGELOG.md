# @cotal-ai/runtime

## 0.76.0

### Patch Changes

- 0cd1f60: An `ask` attempt and an escalated `checkpoint` now relay the instant their pause denies at, and the manager holds the relay to that instant. The relay used to send a duration the manager counted from its own acceptance, so the manager could still serve an attempt after its pause had expired, by the submit's round trip plus clock skew, or by up to a second from a one-second floor. The manager's `turn` command takes `deadlineAt` as an alternative to `deadlineMs` and refuses a relay whose deadline has already passed with `deadline-exceeded`. The run reads that refusal as nobody left to tell only when its own clock also shows the deadline passed. An `ask` whose deadline passes before its attempt's pause is minted now ends with its own `ask-deadline` L4006 instead of an L4000 from the refused mint.
- 8e0876b: Comments in core, the manager and the runtime cite SPEC sections and code symbols instead of line numbers. Nine of those line numbers pointed at unrelated text, including the `EpGateState.space` doc in core's published types, which also named §13.9 for the per-space auth bucket that §13.12 defines. The comments now name the alias-reuse gate in the manager's spawn path, `resolveService`'s `instanceId` option and the `pinnedInstanceId` it returns, the spawn affinity gate, the auth session ledger's `reconcileSessionForTakeover`, and each SPEC section without a line. No behavior changes.
- e65de9e: Fix a hosted `checkpoint` with `onExpiry: "escalate"` failing L4000 every time its first attempt expired. The escalated attempt read the first attempt's binding as its own, so it armed at the first attempt's already-passed deadline and never recorded its own. Each attempt now binds its index with its deadline: the escalation opens with a fresh `timeout`, records its addressee and deadline, and a resumed attempt keeps the deadline it recorded.
- Updated dependencies [58a725f]
- Updated dependencies [7829cbb]
- Updated dependencies [8e0876b]
- Updated dependencies [d85ca1a]
- Updated dependencies [20c93a1]
- Updated dependencies [715928c]
- Updated dependencies [a4b0467]
- Updated dependencies [08d92b7]
- Updated dependencies [35fdda8]
- Updated dependencies [7b34e9a]
- Updated dependencies [d153172]
- Updated dependencies [ea15e8d]
- Updated dependencies [9adcf1c]
- Updated dependencies [15d10c9]
- Updated dependencies [0eb8eff]
- Updated dependencies [ba76f78]
- Updated dependencies [f2a4bde]
- Updated dependencies [8be669e]
- Updated dependencies [42b28aa]
- Updated dependencies [720dbc3]
  - @cotal-ai/core@0.76.0
  - @cotal-ai/workspace@0.76.0
  - @cotal-ai/lang@0.76.0

## 0.75.0

### Patch Changes

- Updated dependencies [6286d29]
- Updated dependencies [ed0785d]
- Updated dependencies [625659e]
- Updated dependencies [0c924f4]
- Updated dependencies [b48a740]
- Updated dependencies [597fa25]
- Updated dependencies [cb3a177]
- Updated dependencies [5f5196f]
- Updated dependencies [d269d1d]
  - @cotal-ai/core@0.75.0
  - @cotal-ai/workspace@0.75.0
  - @cotal-ai/lang@0.75.0

## 0.74.0

### Patch Changes

- 5443012: The runtime's poll and retry loops now wait through one shared helper, whose timer never holds the process open. Each loop used to build its own wait inline, and the copies disagreed: the checkpoint answer's mint-window retry kept the process alive while every other wait did not. That retry now follows the same rule, which changes nothing a caller can see, because it reads over a broker connection that already keeps the process alive.
- Updated dependencies [f3e6f95]
- Updated dependencies [328d59b]
- Updated dependencies [ac251fd]
- Updated dependencies [e3498d9]
  - @cotal-ai/core@0.74.0
  - @cotal-ai/workspace@0.74.0
  - @cotal-ai/lang@0.74.0

## 0.73.0

### Patch Changes

- Updated dependencies [9873985]
  - @cotal-ai/core@0.73.0
  - @cotal-ai/workspace@0.73.0
  - @cotal-ai/lang@0.73.0

## 0.72.1

### Patch Changes

- Updated dependencies [07fe6b3]
  - @cotal-ai/core@0.72.1
  - @cotal-ai/workspace@0.72.1
  - @cotal-ai/lang@0.72.1

## 0.72.0

### Patch Changes

- Updated dependencies [c5a45ab]
- Updated dependencies [18e7e91]
  - @cotal-ai/core@0.72.0
  - @cotal-ai/workspace@0.72.0
  - @cotal-ai/lang@0.72.0

## 0.71.0

### Patch Changes

- 518351a: A run's `turn` and `wait(down)` no longer read a seat as down while the manager still runs it. On a loaded host a live seat's presence heartbeats could stall for more than the 30-second lapse window while its process kept working, and the run failed the turn with L4002 (`lapsed`) although the seat went on to finish its step. Once a lapse is confirmed from presence, the run now asks the manager with `inspect`: if the manager still runs that incarnation, the 30 seconds start over; if the manager that spawned the seat no longer runs it, or that manager does not answer, the lapse stands and the turn fails with L4002 as before. In a space with several managers, another manager's miss does not count, since a manager knows only its own seats. The asking stops at a cancellation, the wait's timeout, or the turn's deadline or yield, so a late answer or refusal never replaces the timeout's `null` or the turn's own outcome. A run host's credential now carries the `inspect` request for this.
- Updated dependencies [b9daf53]
- Updated dependencies [3518435]
- Updated dependencies [726a750]
- Updated dependencies [3400d53]
- Updated dependencies [518351a]
  - @cotal-ai/core@0.71.0
  - @cotal-ai/lang@0.71.0
  - @cotal-ai/workspace@0.71.0

## 0.70.2

### Patch Changes

- @cotal-ai/core@0.70.2
- @cotal-ai/workspace@0.70.2
- @cotal-ai/lang@0.70.2

## 0.70.1

### Patch Changes

- b83ec25: `cotal run migrate` no longer says a pending orphaned `waitUntil`'s cadence timer "is released with the run's other timers". Nothing releases that pause, so the row now says only that the edit stops the wait and its recorded observations stay in the journal, as the §11.2 orphan table does. A single observation now reads "1 recorded observation stays".
- 25237f0: A workflow run that cancels a branch now withdraws what that branch relayed to a seat. The manager serves the reserved `cancel` (SPEC 13.6 item 4) for a turn it relays: the caller's own goal moves to `cancelling`, leaves `turn-pending` and ends `cancelled`, and a later yield of it is answered with that terminal. A goal that already ended is refused with its cached outcome, and one the manager does not relay is refused unchanged. The run sends it as a cancelled `turn`, `ask` attempt or escalated `checkpoint` unwinds, before the branch's scope settles, and its cancellation sweep sends it again for a process that died first. In a space with more than one manager, a cancel refused by a manager other than the one that accepted the relay is sent again until the accepting manager answers. A cancel the accepting manager refuses is sent again until it lands or the relay's deadline passes, and a failed read of that deadline is retried as well (a goal record that is not JSON fails the step at once), so a transient failure no longer lets the branch's scope settle with the relay still on the seat. Before this, a race loser's turn stayed on the seat: the seat could still pull and answer it, and because a seat is shown one turn at a time, the run's next turn to that seat waited behind it until its deadline. The hosted run's credential carries the new `cancel` row, and the manager's cluster document moves to revision 23.
- Updated dependencies [9c99ee5]
- Updated dependencies [da6dba0]
- Updated dependencies [032522a]
- Updated dependencies [5c6c92d]
- Updated dependencies [6d81d61]
- Updated dependencies [fe54eb0]
- Updated dependencies [1ef1396]
- Updated dependencies [66a0f19]
- Updated dependencies [2be1384]
- Updated dependencies [25237f0]
- Updated dependencies [6bd6099]
- Updated dependencies [ed1e171]
  - @cotal-ai/core@0.70.1
  - @cotal-ai/lang@0.70.1
  - @cotal-ai/workspace@0.70.1

## 0.70.0

### Minor Changes

- 83a6352: A run on the compiled engine no longer reports a value the program threw as a host hold or release. The worker thread used to copy `code`, `reason`, `step` and `kind` off whatever was thrown, and the host rebuilt `RunHeld` or `RunReleased` from the code alone, so `throw { code: "L5025", reason: "..." }` came back as a held run with the placeholder step `(step not carried)`, and `throw { code: "L5012", ... }` as a release. Both now fail as the plain value they are, as they do on the walker. `WorkerRunFailed` is now a union discriminated by `class` (`released`, `held`, `effect`, `too-large`, `rejected` or `error`). The thread picks the variant with `instanceof`, each variant requires its class's fields, and the host rebuilds the class with no defaults. `tooLarge` is replaced by the `too-large` variant's `stepKey`, `bytes` and `bound`. This breaks code that calls `runInWorker` itself: `code` now crosses only on the `effect` and `error` variants, so a caller that branched on `L5012`, `L5025`, `L5006` or `L5010` branches on `class` instead.

### Patch Changes

- Updated dependencies [392bfeb]
- Updated dependencies [66df6c0]
- Updated dependencies [0ec35c2]
- Updated dependencies [015f805]
- Updated dependencies [2cbfe9c]
- Updated dependencies [1b11c4e]
- Updated dependencies [c088c5c]
- Updated dependencies [b413e2a]
- Updated dependencies [7986785]
- Updated dependencies [12bfc34]
- Updated dependencies [4dcfa0b]
- Updated dependencies [fd07b1e]
- Updated dependencies [8dc360c]
- Updated dependencies [cce8dad]
- Updated dependencies [c7e0c0a]
- Updated dependencies [2639a13]
- Updated dependencies [668f6b0]
- Updated dependencies [83a6352]
- Updated dependencies [15b7920]
  - @cotal-ai/workspace@0.70.0
  - @cotal-ai/core@0.70.0
  - @cotal-ai/lang@0.70.0

## 0.69.0

### Patch Changes

- 94996e5: The scope kinds' traits now come from one record keyed by `ScopeKind`, exported as `scopeTraits`, which returns a frozen row: whether a scope settles an assembly of branch outcomes, and whether a fork whose cut lies inside it re-enters it. The journal seed check, the scope value rule, the static captured-write check (L2032) and `planFork` read it instead of keeping their own kind lists, so a scope kind added to `ScopeKind` does not compile until it is classified. Before, a new kind compiled with a list missed and failed only at run time, for example a settled no-return scope of that kind refused at the journal seed with L5024. Shipped behaviour is unchanged.
- 0c5b205: `cotal run start`, `resume`, `ps`, `journal` and `answer` now re-describe and re-issue an unpinned manager call that a sibling manager refused before running it, up to the same 16 attempts the CLI's manager commands use. Before, one such refusal ended the command, so in a space with two managers about half of these calls failed with a refusal saying the command was not run. A hosted run's own manager calls now use that bound too instead of 8. The repair is one core helper, `invokeRepairingSplit`, which the CLI and the runtime both call.
- 848497f: A hosted run's presence reader now keeps only rows whose `card` carries a string `id` and `name`, and skips every other value the way it already skipped bytes that are not JSON. A participant that published `null` under its own presence key used to make every `wait(down(...))`, turn liveness poll, conclave join and worktree-reuse check in that space fail with `L4000` (`Cannot read properties of null (reading 'card')`). Those reads now ignore the row and answer about the agent they watch.
- f409b46: A `waitUntil` whose first observation is not terminal now waits out its cadence on a host that checks journal authority (a manager-hosted run, or `cotal run start --local`) and fails `L4023` at its deadline. Before, its second observation failed `L4000`: the interpreter sent the observation index as the effect's attempt, which the run authority refused, and the authority listed no pause token for a `waitUntil` cadence. Which pause tokens a step owns is now one table that the run authority, the adoption re-arm and a cancelled branch's discharge all read, so a cancelled `waitUntil` on a hosted run also releases its open cadence pause.
- Updated dependencies [f5cb8e1]
- Updated dependencies [2d45766]
- Updated dependencies [03a7405]
- Updated dependencies [a256e2f]
- Updated dependencies [3f3d04a]
- Updated dependencies [4500563]
- Updated dependencies [1bdc7f2]
- Updated dependencies [94996e5]
- Updated dependencies [5eb1e24]
- Updated dependencies [69232cd]
- Updated dependencies [02c0a2d]
- Updated dependencies [93716c3]
- Updated dependencies [3a1716d]
- Updated dependencies [9772fd4]
- Updated dependencies [06429be]
- Updated dependencies [adab793]
- Updated dependencies [d29d4d3]
- Updated dependencies [539266a]
- Updated dependencies [b584718]
- Updated dependencies [0c5b205]
- Updated dependencies [98d2b41]
- Updated dependencies [f409b46]
  - @cotal-ai/workspace@0.69.0
  - @cotal-ai/core@0.69.0
  - @cotal-ai/lang@0.69.0

## 0.68.0

### Minor Changes

- 6141e7b: The issuing host no longer signs an answering run operator for a checkpoint token a participant manager names. The manager's request now names the run and step it answers (`operator.answers: { runId, stepKey, amend? }`), and the host requires that run admitted on the manager's instance, reads the pause's token off the run's journal under a read it mints for that run, and requires a served answer to name the same run and step as the request it observed. Before, a manager could be issued the answer and settle writes for another instance's waiting pause. The pause lookups `openCheckpointToken`, `settledPauseToken`, `stepPauseToken`, `CheckpointNotOpen` and `CheckpointNotAmendable` move to `@cotal-ai/lang`; `@cotal-ai/runtime` still exports the first four. A participant manager and its issuing host must upgrade together.

### Patch Changes

- Updated dependencies [6141e7b]
- Updated dependencies [4120c97]
- Updated dependencies [218006f]
- Updated dependencies [681c5b0]
- Updated dependencies [585fdb2]
- Updated dependencies [a5256fd]
- Updated dependencies [0d806ae]
- Updated dependencies [b38a683]
- Updated dependencies [d5ea4d2]
- Updated dependencies [54e0199]
- Updated dependencies [9b439e8]
- Updated dependencies [41a7e66]
- Updated dependencies [f018376]
- Updated dependencies [6a1789b]
- Updated dependencies [237c813]
  - @cotal-ai/core@0.68.0
  - @cotal-ai/lang@0.68.0
  - @cotal-ai/workspace@0.68.0

## 0.67.0

### Patch Changes

- c3601f9: A logged-in user's workflow run on a `cotal supervise` participant manager can spawn, turn and despawn agents that user owns and receive their typed answers. The run's spawn takes the admin reach of the user who started the run, read from that user's actor-ledger row when the spawn runs, so a space that requires the event plane no longer refuses it and a revoked login demotes it. The host pins each run mediator it signs for a participant manager to a placement on that manager's own instance, so a program may place a spawn there; a placement on any other instance is refused at `run start`. A completed run now releases a seat by the identity its spawn terminal records, so a seat the host enrolled at its own lifecycle UID is despawned instead of left running.
- Updated dependencies [48f18d0]
- Updated dependencies [e85e1fd]
- Updated dependencies [55061ff]
- Updated dependencies [5b0da88]
- Updated dependencies [e65ec69]
- Updated dependencies [79e5268]
- Updated dependencies [bb0b14e]
- Updated dependencies [3069425]
- Updated dependencies [ae5b3cd]
- Updated dependencies [954a78b]
- Updated dependencies [f389576]
- Updated dependencies [562a56b]
  - @cotal-ai/core@0.67.0
  - @cotal-ai/lang@0.67.0
  - @cotal-ai/workspace@0.67.0

## 0.66.1

### Patch Changes

- Updated dependencies [568f718]
  - @cotal-ai/workspace@0.66.1
  - @cotal-ai/core@0.66.1
  - @cotal-ai/lang@0.66.1

## 0.66.0

### Patch Changes

- a9be586: Apply the driver's result bound on the compiled engine. A hosted run on language version 2 never received the result bound that `cotal run` and the manager derive from the broker's `max_payload`, so an oversized effect result was recorded when it fit the store, or released as the store's own L5010 when it did not. The bound now reaches the journal the worker thread builds, an oversized `ok` result is refused ahead of the settling append (L5006) as it is on version 1, and the host rebuilds that refusal as `EffectResultTooLarge`, so the driver releases the run instead of recording it as failed. `WorkerRunRequest` gains `resultBytes`, refused outside the bridged route, and `WorkerRunFailed` gains `tooLarge`.
- Updated dependencies [a9be586]
- Updated dependencies [a07f732]
- Updated dependencies [be53e2d]
- Updated dependencies [658c1b8]
- Updated dependencies [af779f9]
  - @cotal-ai/lang@0.66.0
  - @cotal-ai/core@0.66.0
  - @cotal-ai/workspace@0.66.0

## 0.65.0

### Minor Changes

- 8577576: Add `once`, an at-most-once scope for cotal-lang steps that write to a far side. A resume that finds a step inside `once` begun and never settled does not dispatch it again: it opens a hold, a checkpoint minted under `holdRequestId` of the step's recorded request id, and the answer becomes the step's result, while an expired hold fails the step with the catchable L4027. A hold the host refuses leaves the step pending rather than refused, so no later host writes again, and its L5025 says so. A hold whose checkpoint answers an outcome other than `resolved` or `expired` fails the step as a handler fault. Only `ask` runs inside `once`; every other effect is refused before it begins (L4028), and a write from the body to a binding outside it is refused (L2032). The journal entry gains a `hold` field for the hold's own binding. The hosted runtime ends the held `ask`'s open attempt pause before the hold binds, and `cotal run answer`, `cotal run amend` and `cotal run journal` read a held step at its hold. A fork may cut inside `once`, and a migration ignores an orphaned `once`. `once` becomes a reserved name, so a program that declares its own `once` binding is refused (L2002). The design record is `docs/design/at-most-once-external-effect.md`.

### Patch Changes

- Updated dependencies [ba5468d]
- Updated dependencies [8577576]
- Updated dependencies [451ffee]
- Updated dependencies [f01aa7c]
- Updated dependencies [2cef9e6]
  - @cotal-ai/core@0.65.0
  - @cotal-ai/lang@0.65.0
  - @cotal-ai/workspace@0.65.0

## 0.64.0

### Patch Changes

- Updated dependencies [eb2b2d5]
- Updated dependencies [6c79419]
- Updated dependencies [d121d21]
  - @cotal-ai/lang@0.64.0
  - @cotal-ai/core@0.64.0
  - @cotal-ai/workspace@0.64.0

## 0.63.0

### Minor Changes

- c975258: A logged-in user can now run hosted workflows on a user-auth space. The auth callout issues an interactive user's `manager-caller` view as an issuance (SPEC 13.15): it chooses the generation, records evidence whose one source is the user's actor-ledger row, and writes the accepted row under a token derived from the connection's inbox nonce, renewing that generation on a reconnect whose ceiling is unchanged. `cotal run` and the other manager calls read the generation back with the new `issuedUserCaller` and ride `ep.v1`, so `cotal run start` against a participant manager started with `cotal supervise` is admitted. The issuing host admits a run from a user caller only for the manager's registered owner, and a participant manager now forwards the served subject of every caller resume and answer, which the host checks against the run's owner and the caller's live issuance; a legacy-rail resume is refused. The issuing host subscribes to those resume and answer request subjects itself and issues for a forwarded one only when it observed that request, only once, and only for the run a resume's envelope names or the endpoint and amendment an answer's envelope names, and never for a request bound to another manager instance or epoch or declaring another class or pinning another contract than the manager registered for that command. Every answering operator issuance must carry that served subject, and an amendment's carries `answers.amend: true`, which the host accepts only for a pause settled with an accepted answer, so `cotal run amend` works on a participant manager. A user caller starts, resumes and answers runs only on the participant manager that user registered, and a static caller keeps its admission there. A managed seat's manager call keeps the legacy rail when the broker refuses its accepted-row read, which surfaces as a request error caused by the permission violation. Revoking or re-granting the actor makes its issuances dead at the next resolution. New exports: `connectionAcceptedToken`, `actorLedgerSource`, `actorLedgerSourceBucket`, `parseActorLedgerSource`, `issuedUserCaller` and `isDerivedOwner` in core, and `ledgerActorSourceIsLive` and `UserCallerIssuer` in auth. `manager-caller` joins the issuable profiles, and the `issuer` profile gains the per-key read of the accepted store. SPEC §13.15 gains a **User-auth issuance** paragraph and §14.8 a **User-auth runs** paragraph, both insertions; `docs/design/user-auth-run-start.md` records the path, and `docs/cli.md`, `docs/workflows.md` and `docs/run-a-mesh.md` describe it. `docs/run-a-mesh.md` also says the stock auth service refuses managed-agent enrollment and retirement preparation for a host platform to intercept.

### Patch Changes

- Updated dependencies [62ebc6b]
- Updated dependencies [22e210a]
- Updated dependencies [cb6a0bf]
- Updated dependencies [5738154]
- Updated dependencies [101c9b0]
- Updated dependencies [9d5cc09]
- Updated dependencies [c975258]
  - @cotal-ai/core@0.63.0
  - @cotal-ai/workspace@0.63.0
  - @cotal-ai/lang@0.63.0

## 0.62.0

### Minor Changes

- b36bebf: `cotal spawn --detach` run from a managed seat's own shell on a static or open mesh now launches as that seat, so the manager records the seat as the spawner and the seat can stop the child with `cotal_despawn`, as it can a `cotal_spawn` child. Before, the CLI minted a one-shot operator instrument that no session could present again, and the seat's despawn was refused. `--on <instance>` keeps its pin on that path: on a static mesh the CLI mints a one-shot `manager-caller` view for the seat, pinned to that instance and carrying the spawn subject only when the seat's own credential holds it. On an open mesh the seat's call keeps the TLS requirement the mesh records, and `--server` with an unregistered `--space` keeps the operator path. Without `--space` the seat's target is picked as the operator path picks it, skipping a recorded mesh that is not running. The child is now stopped when the seat exits, and on a static mesh a seat without `capabilities: [spawn]` is refused. The seat-scoped control target that `cotal run` already used on a static mesh moves to `@cotal-ai/workspace` as `resolveSeatControlTarget`; `cotal run` keeps using it on a static mesh only. On a static mesh the seat's credential also proves its space, so a seat launched without `COTAL_SPACE` still acts as itself, as `cotal run answer` did before; an open mesh acts as the seat only when `COTAL_SPACE` names its space. See docs/UPGRADING.md.

### Patch Changes

- Updated dependencies [bcf66d6]
- Updated dependencies [1b3ba08]
- Updated dependencies [97a2382]
- Updated dependencies [877909b]
- Updated dependencies [5ef9a67]
- Updated dependencies [565036c]
- Updated dependencies [9236a12]
- Updated dependencies [b36bebf]
  - @cotal-ai/core@0.62.0
  - @cotal-ai/lang@0.62.0
  - @cotal-ai/workspace@0.62.0

## 0.61.0

### Patch Changes

- @cotal-ai/core@0.61.0
- @cotal-ai/workspace@0.61.0
- @cotal-ai/lang@0.61.0

## 0.60.0

### Patch Changes

- Updated dependencies [3b616a2]
- Updated dependencies [6ca4d8e]
  - @cotal-ai/core@0.60.0
  - @cotal-ai/workspace@0.60.0
  - @cotal-ai/lang@0.60.0

## 0.59.0

### Patch Changes

- 904f4b2: A hosted run that completes now despawns every seat it spawned, including a race winner's, a plain sequential spawn, and a spawn that failed catchably while its process stayed up. Before this, only seats on cancelled branches were released, so a long-lived orchestrator accumulated seats until the manager refused further spawns. A fork child never releases a seat copied from its parent, and a spawn marked `onFork: "adopt"` is never released at completion, because a fork may still be using it. A seat a migration handed to a later spawn follows that spawn's policy, and stays up if any spawn that held it was marked `onFork: "adopt"`. In a space with several managers a despawn treats a seat as already gone only when the manager that allocated it says so, and it retries a despawn another manager refused before running it.
- 608f5f4: Re-attach doc comments that had drifted away from the declarations they document. A `/** */` block followed directly by another one documented nothing, so editor hovers and the published type declarations showed no doc for the intended declaration (for example `Manager`, the `plane3` field and `AclResolver`). Each such block now sits above its declaration, is merged into the block it duplicated, or is removed when its declaration no longer exists. A new `pnpm check:doc-comments` check, run as part of `check:docsbundle`, refuses a doc block followed directly by another in shipped source.
- 4a12111: The hosted `cotal run ps` now reads each run's revocation marker, as `run ps --local` already did. A revoked run whose driver died is listed as `revoked` with the revoker and reason instead of `running`, and a marker the manager cannot read prints `unchecked` and exits 1. The `run-ps` rows gain optional `revoked` and `revocationUnreadable` fields; the record's own `state` is unchanged.
- f485c49: A run driver now advances the run record's `journalHigh` after every journal append, before the program acts on the entry. A tail delete of records appended since the last activation used to leave a short journal that a successor resumed from, performing those effects again. The successor now refuses it with `RunJournalTailTruncated`.
- 7b39a0b: `spawn` in a workflow program accepts `events`, the workflow form of `cotal spawn --no-events`. `events: false` starts the seat without its AG-UI event plane, so a hosted run can now start a connector that publishes none, such as Hermes. Before this the option was refused as an unknown key (L3011), and the same spawn without it was refused by the manager because an omitted `events` arms the plane. A value that is not a boolean is refused at the spawn. Like `supervise`, the option is launch policy and is not part of the step's input hash.
- d0b1da3: Record a changed answer on a settled run step. `cotal run amend <runId> <stepKey>` files a new answer beside a settled checkpoint's or ask's accepted one, naming the answer it supersedes, and `cotal run journal` lists each amendment under the step in the order the store committed them, so the last one is the current position. Each filing is its own record, so returning to an earlier position is listed too. A settled `ask` now prints the answer it accepted, as a checkpoint does, read from its answer record even when the value is a record with fields named like a checkpoint's result. The pause stays settled and the run keeps the answer it acted on; a second `answer` is still refused. The hosted path is the `amend` form of the manager's `run-answer` command (cluster revision 19), and a spawned seat may amend only an answer recorded under its own name.
- 37075a2: `cotal run ps` and `cotal run journal` take `--json`, hosted or `--local`: one JSON object per row per line on stdout, with the run header and errors on stderr, as `cotal ps --json` does for seats. A run row adds its pinned `startedAt` and the `programHash` of its recorded program. A step row adds its effect kind and name, the recorded status and error code, its start and end times, and for an open pause its deadline and the `onExpiry` a checkpoint was armed with, which a checkpoint now records on its pending entry. An unreadable revocation marker under `--json` prints its reason to stderr and exits 1. `run ps --local` now reads its rows through the same listing the manager answers `run-ps` with, so both paths print the same rows.
- 63b8bb7: A run's `turn` and `wait(down)` no longer read a seat as down from one presence read that misses its row. A seat's presence row expires 6 seconds after its last heartbeat, and a seat whose connector stalls longer than that, under host load or across a reconnect, renews the same incarnation's row once it resumes. On a loaded host one such gap failed the turn with L4002 (`lapsed`) while the seat kept working, and the run threw away the sibling branches of a `parallel` with it. A lapsed row now counts as the death only after it has stayed absent for 30 seconds, observed by presence reads that follow each other within the row's 6-second TTL: a slow presence read or a run of failed reads could hide a renewal, so it starts the 30 seconds over instead of counting as absence. A row held by a different incarnation of the same name (`superseded`) still counts at once, and a seat that really died is still reported as L4002, about 30 seconds later than before.
- Updated dependencies [70bcfe3]
- Updated dependencies [1cf7f72]
- Updated dependencies [5bec8b2]
- Updated dependencies [6c01470]
- Updated dependencies [acb713e]
- Updated dependencies [77e2654]
- Updated dependencies [cfc3b95]
- Updated dependencies [b669a73]
- Updated dependencies [350c87b]
- Updated dependencies [608f5f4]
- Updated dependencies [43c4179]
- Updated dependencies [4a12111]
- Updated dependencies [569cb6f]
- Updated dependencies [b4c69bf]
- Updated dependencies [f485c49]
- Updated dependencies [7b39a0b]
- Updated dependencies [5f13124]
- Updated dependencies [fb1bc26]
- Updated dependencies [c389563]
- Updated dependencies [06f48f4]
- Updated dependencies [eb2681e]
- Updated dependencies [fb1bc26]
- Updated dependencies [438e9ed]
- Updated dependencies [446ed23]
- Updated dependencies [15c16ff]
- Updated dependencies [8ce6be3]
- Updated dependencies [08194ec]
- Updated dependencies [aa12a1a]
- Updated dependencies [d90f9f2]
- Updated dependencies [499bd8a]
- Updated dependencies [569cb6f]
- Updated dependencies [d0b1da3]
- Updated dependencies [37075a2]
- Updated dependencies [8d8d69a]
- Updated dependencies [c7bfc2d]
- Updated dependencies [6145abc]
  - @cotal-ai/workspace@0.59.0
  - @cotal-ai/core@0.59.0
  - @cotal-ai/lang@0.59.0

## 0.58.0

### Patch Changes

- 417b5f0: Replay a drive's own journal again when a read loses a round, instead of failing the step

  A drive reads its journal through one replay durable named after its takeover, before every effect
  and at every poll of a parked pause. When another reader held that durable, the read raised
  `RunJournalReplayRaced` and the interpreter recorded it on the step as `L4000 handler-fault`, so one
  branch of a `parallel` failed on a healthy run. `activateRun` already treats the same error as a
  lost round and replays again.

  The reads behind a drive's steps (`RunScopeAuthority`, hosted and under `cotal run --local`) and the driver's diagnostic for a
  journal with no run record now do the same, with the takeover's bound: up to three replays, one
  straight after another, and the race is raised unchanged when the third is lost too. An operator
  read runs under a takeover id minted for that one read (the manager and `cotal run` mint a fresh one
  per call), so `RunHost.status`, `RunHost.locate` and `cotal run journal` still report the race on
  their first read.

  Only the race is retried. A reader in another process can also tear a fetch or return an empty
  replay; neither is retried here.

  A new suite, `smoke:runtime-run-host-replay`, drives the manager's run host through a `parallel` of
  three `ask` steps answered within the same second: once while `RunHost.status` reads the drive's
  own takeover id, and once while another connection takes records off the drive's durable. No branch
  fails in either.

  The `connector-core` docs bundle is regenerated for the updated paragraph in `docs/workflows.md`.

- 1721738: Support signerless manager run hosting through typed host admission, initial-attempt and renewal operations. Renew the complete standing credential family while preserving held identities, serve epochs and last-good credentials on refusal. Keep pooled managers off local PTY launch paths and enforce the execution host boundary. Update the native lifecycle and mutation checks for these paths.
- Updated dependencies [0589316]
- Updated dependencies [59a7e64]
- Updated dependencies [95ae645]
- Updated dependencies [fba1537]
- Updated dependencies [576f622]
- Updated dependencies [2457692]
- Updated dependencies [ee6de5d]
- Updated dependencies [4229e53]
- Updated dependencies [e9ef5b3]
- Updated dependencies [7c54825]
- Updated dependencies [2c31f95]
- Updated dependencies [397bc60]
- Updated dependencies [7b3924c]
- Updated dependencies [1721738]
  - @cotal-ai/core@0.58.0
  - @cotal-ai/workspace@0.58.0
  - @cotal-ai/lang@0.58.0

## 0.57.0

### Patch Changes

- Updated dependencies [e7c702a]
- Updated dependencies [6f64bcc]
- Updated dependencies [42448fa]
- Updated dependencies [ae90f5d]
- Updated dependencies [33357d9]
  - @cotal-ai/core@0.57.0
  - @cotal-ai/lang@0.57.0
  - @cotal-ai/workspace@0.57.0

## 0.56.1

### Patch Changes

- Updated dependencies [6b76946]
  - @cotal-ai/core@0.56.1
  - @cotal-ai/workspace@0.56.1
  - @cotal-ai/lang@0.56.1

## 0.56.0

### Patch Changes

- Updated dependencies [e506040]
- Updated dependencies [8dc7c92]
- Updated dependencies [493eef5]
- Updated dependencies [99cad7b]
- Updated dependencies [1218786]
- Updated dependencies [ef8889d]
  - @cotal-ai/core@0.56.0
  - @cotal-ai/workspace@0.56.0
  - @cotal-ai/lang@0.56.0

## 0.55.0

### Patch Changes

- Updated dependencies [888e9bc]
- Updated dependencies [810814b]
- Updated dependencies [8472dc3]
- Updated dependencies [f272f71]
- Updated dependencies [a83dd80]
- Updated dependencies [db9a969]
- Updated dependencies [d284ee6]
- Updated dependencies [4f48629]
- Updated dependencies [2e13607]
- Updated dependencies [d3d6742]
- Updated dependencies [2b28653]
- Updated dependencies [fd58782]
- Updated dependencies [357af9f]
  - @cotal-ai/core@0.55.0
  - @cotal-ai/workspace@0.55.0
  - @cotal-ai/lang@0.55.0

## 0.54.0

### Minor Changes

- 34beea1: Route user-auth manager calls through a short-lived, instance-bound control credential. Discovery and invocation address the same authorized manager while the agent's standing connection, credentials and conversation remain unchanged. Managed launches retain their manager selection across launch and resume. Static and open mesh routing is unchanged. Confirm the standing goal-progress subscription at the broker before submitting on the separate control connection, so fast terminal events cannot outrun the subscription. Recover accepted goal results through the manager's caller-scoped `goal-result` command after connection replacement, without repeating the mutation or granting clients raw JetStream reads. Followed calls now require a compatible manager before submission; update the issuer, participant manager and client together. Stopping a caller cancels its observation without cancelling the accepted goal. Retain Linux custody records across clean child exit so retirement can prove process identity and finish cleanup even after the custodian removes its file; socket loss alone never frees the alias.

### Patch Changes

- Updated dependencies [e6badb8]
- Updated dependencies [34beea1]
- Updated dependencies [b4317fd]
  - @cotal-ai/core@0.54.0
  - @cotal-ai/workspace@0.54.0
  - @cotal-ai/lang@0.54.0

## 0.53.0

### Patch Changes

- Updated dependencies [d1f9703]
- Updated dependencies [104921c]
- Updated dependencies [83617ab]
  - @cotal-ai/workspace@0.53.0
  - @cotal-ai/core@0.53.0
  - @cotal-ai/lang@0.53.0

## 0.52.1

### Patch Changes

- Updated dependencies [5784ec9]
- Updated dependencies [f17791d]
  - @cotal-ai/core@0.52.1
  - @cotal-ai/workspace@0.52.1
  - @cotal-ai/lang@0.52.1

## 0.52.0

### Minor Changes

- 5ee8eef: Let a workflow-spawned seat answer an ask or escalated checkpoint addressed to its own incarnation with its baseline credential. `run-answer` is now self-targeted, the manager checks the caller against the pending relay before writing an answer, connector turn text renders the hosted command without `--by`, and that literal command reuses the managed seat's issued caller identity. Other seats, unrelayed checkpoints, other runs, and run start or resume remain refused. Fixes #1877.
- 5b2c19f: Let hosted workflow runs resolve an existing absolute working directory on the selected manager and launch the placed seat in its canonical path.

### Patch Changes

- c902af4: `settleOnce` now drains the fire pump before it returns: the wait's answer is still decided by the race (fact, failure, or cancellation), but the settle does not return until the pump's in-flight `takeFire` has ended, and the pump re-checks `wait.over` after each fire so it stops without starting another. Before (#1460), a settle whose fire was mid-flight returned as soon as its fact was observed, so a completed `driveRun` could resolve while the pump's journal replay under the run's takeover id was still open — the replay consumer appeared after the drive had returned, and the next reader under the same takeover hit `RunJournalReplayRaced` cross-process about a driver that no longer existed. A failed pump still raises through the drain exactly as it did through the race.
- c44aaf8: Show a settled workflow pause's accepted answer and attribution in the run journal.
- 8bd4279: `cotal run migrate <runId> --local --file <program>` now runs the migrate check from the terminal. The check existed as `migrateRun` and nothing could call it: the verb table refused `migrate` as usage, while `resume --file` refused an edited program and named "a migration or a fork" as the remedy. The verb reads the run record (pins read back, never re-derived) and the journal under the same one-shot run-operator credential `journal` uses, walks the edited program over the recorded journal, prints whether the migration is admissible, how many journal rows the walk accounted for, every orphaned step with its verdict and code, the divergence or unwalkable step when there is one, and exits 0 on admissible and non-zero on not. It writes nothing: the commit side (`commitMigration`) is not reachable from any surface yet, and the printed report says what a commit would file and that this invocation filed nothing. Commit-side overrides (`--adopt`, `--release`, `--discard-approvals`) are parsed only so the verb can refuse them by name, and the hosted path refuses with the sentence naming `--local` (the manager serves no run-migrate command). Refs #1529.
- Updated dependencies [5ee8eef]
- Updated dependencies [2e7558d]
- Updated dependencies [5b2c19f]
- Updated dependencies [d69aefd]
- Updated dependencies [b3db3a2]
- Updated dependencies [c44aaf8]
- Updated dependencies [fe81419]
- Updated dependencies [93b42cd]
- Updated dependencies [a069948]
- Updated dependencies [cf5a5cb]
- Updated dependencies [ab0808c]
- Updated dependencies [7ea6fee]
- Updated dependencies [6b375c8]
  - @cotal-ai/core@0.52.0
  - @cotal-ai/workspace@0.52.0
  - @cotal-ai/lang@0.52.0

## 0.51.0

### Patch Changes

- Updated dependencies [db18070]
- Updated dependencies [64d723e]
- Updated dependencies [ade42d5]
- Updated dependencies [4f153ab]
- Updated dependencies [eb65c9b]
- Updated dependencies [314a12c]
- Updated dependencies [4dd4b90]
- Updated dependencies [92a8938]
- Updated dependencies [ec8649b]
- Updated dependencies [949d4d1]
- Updated dependencies [949d4d1]
- Updated dependencies [f50e20d]
- Updated dependencies [a0c8a59]
- Updated dependencies [c18c055]
- Updated dependencies [f178611]
- Updated dependencies [21407fd]
- Updated dependencies [26d864b]
  - @cotal-ai/core@0.51.0
  - @cotal-ai/workspace@0.51.0
  - @cotal-ai/lang@0.51.0

## 0.50.1

### Patch Changes

- c499a85: `cotal run ps --local` now reads the revocation marker beside each run record and prints `revoked`
  for a run that carries one, whatever state the record itself holds, with the revoker and the reason
  under the table. A revocation is a create-only marker in the admission store and nothing rewrites
  the record, which is written only by a driver, so a driver that died mid-run left `running` behind
  with nothing left to write anything else: `resume` refused on the marker while the table listed the
  same run as live indefinitely, and an operator counting capacity from it counted that row. A run
  whose marker could not be read prints `unchecked` in the `STATE` column, since a failed read is
  absence of evidence rather than evidence of absence. The reason and the record's own state go to
  stderr, every other row still prints, and the command exits 1. The change is display only: a revoke
  writes no terminal state, because no host drove the run to one. `revoke` now says what the table
  will show, and `readRunRevocation` reads the marker alone so a listing does not refuse over a run
  with no admission record. `revokeRunAdmission` refuses a revocation with an empty `by` or `reason`
  before it writes, since the argument parser passed `--by ""` through and the permanent marker it left
  printed as `revoked by  ()`; a marker already written that way still reads as a revocation.

  Refs #1621

- Updated dependencies [c499a85]
  - @cotal-ai/core@0.50.1
  - @cotal-ai/workspace@0.50.1
  - @cotal-ai/lang@0.50.1

## 0.50.0

### Minor Changes

- 6f248ac: Enumerate broker spawn sites so an unmigrated suite fails the gate instead of leaking

  The reaper claims a leaked `nats-server` by matching the store-dir token in its argv, and its header
  states the standing condition: it "is only ever as complete as the migration that mints the token".
  #1008 measured what that costs, 108 orphaned brokers on one box in a day, all holding loopback ports
  inside the OS ephemeral range that suites draw from. The five suites it named were migrated, and
  nothing was left behind that could notice the sixth.

  `pnpm smoke:broker-migration` is that missing piece. It names no filenames: it walks `git ls-files`,
  finds every call that starts a `nats-server`, and fails when one is not claimable by the reaper or
  killable by the teardown helper. A suite added next week is in the population on the commit that
  adds it. The census currently reads 319 spawn sites across 297 files, and the gate checks all 315
  that are in scope.

  The census found 98 unadopted sites, not five. Two conditions each break the chain on their own and
  both are now required: the token has to be in a path the broker is STARTED with, since the reaper
  reads argv and nothing else, and the handle has to reach `teardownOnSignal`, since the token only
  helps once the owner is dead. Three shapes were leaking for reasons a named list would never have
  surfaced. A suite minting a tokened store dir but launching with `-c <conf>` put the token somewhere
  argv never carries, so it was unclaimable despite looking migrated. Brokers started with neither
  `-sd` nor `-c` left no evidence at all; those now pass a tokened `-sd` purely as a marker, which
  `nats-server` accepts without JetStream and writes nothing into. And suites that owned one broker
  while leaving a sibling unowned read as clean under any file-level check, so ownership is decided per
  spawn site.

  A deliberate negative control opts out with a `SMOKE_BROKER_UNADOPTED_OK` marker, which is greppable
  and per-site rather than a silent exclusion: `reaper.smoke.ts` must be able to start an untokened
  broker, since that is the case it exists to detect.

  The teardown helper no longer stalls three seconds and then reports a false alarm on every green
  run. It waited on `process.kill(pid, 0)`, which keeps succeeding for a child that has been killed but
  not yet waited on, so a suite whose own `finally` kills the broker first left a zombie that read as
  alive until the deadline elapsed, and the helper then printed `did not exit before path cleanup`
  about a process that was already dead. Liveness now distinguishes a zombie from a running process,
  and a genuinely running broker is still waited on before its store dir is removed.

- 87dda9f: The caller half of a durable spawn's physical working directory, pinned to one manager instance

  A durable spawn can name a physical working directory with `cwd`, and doing so requires an explicit
  `placement` target naming one manager instance as `{ endpoint, instanceId }`. A directory is
  host-local, so a `cwd` with no target would ride the class anycast queue and land wherever the
  anycast fell; that combination refuses rather than guessing, with no fallback. The target is
  hashed into the step identity beside the directory, so a replay retargeted at a different instance
  diverges as a migration instead of replaying a resolution taken against the old host. Logical
  `worktree` keeps its meaning and its exclusivity, and a spawn that names neither option hashes
  exactly the object it hashed before, byte for byte, so recorded runs replay unchanged.

  **Explicit `cwd` placement does not resolve yet on a shipped manager, and refuses by name until it
  does.** What ships here is the caller half: the language forwards and hashes the options, the
  runtime asks its pinned target to state the directory's canonical form before it submits anything,
  and the core grant builder mints the instance-pinned rails that ask would need. The question is
  asked with a `resolve-cwd` command, and **no manager in this release serves `resolve-cwd`** — the
  only servers of it are the smoke suites that grade this code. So on a real manager every explicit
  `cwd` placement ends in a named refusal saying that this manager serves no `resolve-cwd` command
  and can therefore state no canonical form. That is the intended direction and it is not a crash:
  nothing is submitted, allocated or launched, and the caller is told why. A non-`ok` reply and a
  reply whose path is not absolute are refused the same way. Until a manager serves the command,
  treat `cwd` with `placement` as unavailable rather than as a directory that silently differs from
  the one you named.

  The grant surface and the serving surface are deliberately asymmetric, and it is worth stating
  plainly: `runMediatorGrants` does mint the three placement capabilities (`describe`, `resolve-cwd`,
  `spawn`) for the one named instance when a program names a target, bounded to that instance with
  no anycast rail and no wildcard, but the manager's hosted-run credential minting never passes a
  program's placement into it, so an authenticated hosted run receives none of those rows today. The
  rails are built and graded; nothing production yet asks for them or answers them.

  A malformed `placement` is now refused by name at the call. `placement: null` used to raise a raw
  `TypeError` from inside the interpreter's identity projection, with no code, no effect kind and no
  journal entry, because the option reader guarded the option bag being null rather than the value it
  held. A primitive, an empty record and a half-filled record were quieter and worse: they were
  forwarded, projected two undefined fields into the step identity, and the run carried on under an
  identity describing a placement the program never named. All of these are now `L3048`, raised
  before the step key is minted, so nothing is journalled and the repair is an edit to the program.

- fc6f0b1: Scope an unanswered endpoint verdict to the rail the request rode

  A CLI whose caller carries an issued generation rides the versioned `ep.v1` rail. SPEC 13.15 makes
  that rail a separate subject space from the legacy `ep` rail and requires an endpoint to serve
  both, so a manager built before the versioned rail serves `ep` alone and never receives the
  request. The describe waited out its whole budget and every hosted `cotal run` verb reported that
  no manager answered on the endpoint rails, asked whether one was running, and offered `--local`,
  against a manager that was up, on the roster and answering `cotal ps` throughout. `--local` drives
  the run from the calling process and names the caller as the run's answerer, so an operator who
  took the suggestion would submit an answer under the wrong identity.

  The unanswered marker now carries the `ep` plane the request was published on, and `describe`
  names it in its own refusal. `cotal ps` and the other manager verbs state the reachability verdict
  against that rail instead of against the mesh, and say what silence on a versioned rail does not
  establish. `cotal run`'s hosted verbs do the same and drop both the question and the `--local`
  suggestion there, since neither follows from what was observed. On the legacy rail every message is
  unchanged: there is no second rail its silence could be hiding a manager on.

  No fallback describe is issued on the other rail. A caller holds broker rows for its own rail only,
  so the request would be refused at publish rather than answered.

- 5a34b2b: A durable run's unpinned spawn survives the class-queue split instead of dying at it

  A run resolves the manager on the class rail and binds the incarnation that answered its describe.
  The invoke is a second, independent trip through the same anycast queue, so in a space served by
  more than one manager it routinely reaches another member. That member refuses before dispatching
  and says so: SPEC 13.2 marks the refusal `not-executed`, meaning the command did not run and no
  effect of it exists. The refusal is correct for one command and destructive for a run. Raised as the
  effect's own L4000 it ended a durable Lang run at its first `spawn` with no `placement`, consuming
  the run id and its journal, and a retry started a fresh run that failed the same way about half the
  time.

  The manager calls a run performs now re-issue such a refusal rather than returning it. The stale
  class handle is dropped, the endpoint is re-described, and the call goes out again, up to a bounded
  number of attempts, after which the refusal surfaces unchanged and still states that the command
  did not run. This is the licence core's `Endpoint.invokeService` already re-issues on: the marker
  together with `not-executed` is the responder's own statement that the re-issue is a first attempt
  and not a second, so nothing is duplicated. It covers `spawn`, `turn`, the relay a paused `ask` or
  `checkpoint` submits, and the `despawn` a cancelled spawn discharges with.

  A handle pinned to one instance is never repaired. It addresses that incarnation by name, so a
  refusal from it is that instance answering about itself, and re-resolving onto the class rail would
  be the anycast fallback an explicit placement exists to remove.

  The repair converges rather than eliminating: the re-issue draws the same queue, so a space of m
  managers still splits (m-1)/m of the time per attempt. Nine attempts leave two managers a 1-in-512
  residual where the unrepaired refusal was 1-in-2. Removing the residual means addressing one
  instance, which the run's caller holds no instance-rail grant for unless its program named a
  placement.

### Patch Changes

- 5e23b1d: Keep the versioned rail's subject token out of source comments

  The issued-profile census scans every shipped source for the versioned rail's subject token and
  allows only core's subject and grant builders to spell it. Five comments in core, the CLI and the
  runtime spelled the token and failed that cell on main. They now say "the versioned rail" or "the
  versioned plane". No code changes.

- aaedc42: `cotal run journal` renders an expired checkpoint differently from an answered one. A settled
  checkpoint's status is `ok` whether its pause was answered or expired, and the journal render took
  the status, so both read `ok` and an operator could not tell an unanswered human gate from a
  timeout. The render now reads the disposition the settle named (`resolved` / `expired`) from the
  settled result, in both the `--local` journal path and the hosted status view, and keeps the
  settled status for steps whose result is not a checkpoint disposition.
- 43a4281: Fix locally driven workflow starts with publish-channel admission by generating a valid actor token.
- c59d96d: Stop a parked step from dying on one slow pause-plane reply. A workflow `ask` that waited long enough settled `failed` with `{code: "L4000", kind: "handler-fault", message: "timeout"}` while most of its deadline was still unspent, the seat was alive, and nothing in the program threw. Measured on the reporting run: the two asks under 4.5 minutes settled `ok` and the two over 7.5 minutes failed with that exact record, with 11 minutes of deadline left.

  The cause is how long a parked step reads for. While a pause is parked the run host polls the plane for the life of the step, once for the settle fact and once for the broker's fire, each read riding a NATS API request with its own 5s client-side deadline. A reply that arrives after that deadline raises the client's bare `TimeoutError: timeout`, and the interpreter records any non-`EffectError` throw as `L4000 handler-fault` verbatim. So the step issued roughly one unretried request per second for its whole duration and one late reply ended it, which is why the exposure grew with how long the step waited rather than with anything about the program.

  A late reply is a fact about that one request and not about the pause behind it. The pause is a durable record on the plane, its timer is armed, and it is still answerable, so the read is now re-issued rather than raised, and the step settles on the answer it was waiting for. Re-reading is safe for the same reason the starvation repair's re-entry is: the plane's operations are idempotent by construction, and reading a one-use settle fact again observes the same world.

  It is the second half of a distinction the host already drew for #1508 and it reuses that machinery rather than adding its own. A client deadline has two causes that produce the identical error, and the host can tell them apart by measuring whether its own event loop ran: off the CPU is the host's own starvation (`L4025`), and on it is a plane that answered late. The case that moves is only the second, which the classifier previously answered "fault" and handed to the program as its own failure.

  Neither retry is unbounded and neither is merged into the other. A run that cannot be served must fail rather than hang, so the two conditions carry separate counts that are never reset, which bounds the call however they interleave; a host that stays starved still fails under `L4025`, and a plane that never answers now fails under the new `L4026` naming the measurement rather than the effect. The two are kept apart because the remedies differ: one says give this host capacity, the other says the broker is behind. Every failure that is not a client deadline is still raised on the first attempt, unretried and unwrapped, and still recorded as `L4000`.

  A recorded handler fault also carries the stack of the value that was thrown, in a new optional `error.stack` on the journal entry. A handler fault is the one failure class whose cause is in neither the program nor the language, so `message` alone ("timeout") is the symptom with no origin, and the durable entry is usually the only look anyone gets at it. The field is written only when the thrown value carried a non-empty string `stack`: a handler may throw a primitive, and a recorder that trusted the field would replace the handler's failure with its own.

- Updated dependencies [ba91ad5]
- Updated dependencies [06eccc3]
- Updated dependencies [6f248ac]
- Updated dependencies [5e23b1d]
- Updated dependencies [44cdcc2]
- Updated dependencies [6cc504b]
- Updated dependencies [87dda9f]
- Updated dependencies [fc6f0b1]
- Updated dependencies [aaedc42]
- Updated dependencies [4ab8b4b]
- Updated dependencies [fe813fe]
- Updated dependencies [55dae63]
- Updated dependencies [7df3498]
- Updated dependencies [c59d96d]
- Updated dependencies [438c629]
- Updated dependencies [a211c52]
  - @cotal-ai/workspace@0.50.0
  - @cotal-ai/core@0.50.0
  - @cotal-ai/lang@0.50.0

## 0.49.0

### Minor Changes

- 1469d18: Add `waitUntil(probe, { name, every, deadline })`: a durable wait on a resource the mesh does not own. Before this a program could only wait on a mesh event or on the clock, so blocking until something outside the mesh became true meant writing a poll loop, and a poll loop is broken across a resume: the probe's observation of "not yet" was journalled as the step's RESULT and replayed forever, so a resumed run was handed a stale answer for a resource that had since completed, and never looked again.

  A `waitUntil`'s non-terminal observation is now journalled AS AN OBSERVATION and leaves the entry pending, so a resumed run re-observes the world. Only a terminal observation settles the entry, carrying its observation history beside the result. Each observation's probe is journalled in its own key namespace, so the effects one look performs can never be replayed as another look's answer. The deadline is absolute from the entry's start, so a crash does not buy the wait more time, and an elapsed deadline is catchable as `L4023` and reports how many times it looked. The handler is asked only to wait out the cadence: which resource to look at, and what counts as done, stay with the program. `every` and `deadline` are part of the step's identity, so editing either on a resumed run diverges; the predicate is not, so a program can correct it on a run that is already waiting. Neither `every` nor `deadline` may be defaulted, and a cadence longer than the deadline is refused at parse.

  Journals written before this release are unaffected: the new entry shape adds an optional field, and no existing kind changes.

- 36d1779: Issued authority and run admission (SPEC 13.15, 14.8). A static credential is now an issuance: the issuer records its permission ceiling as evidence under a fresh generation before the material exists, its endpoint rows ride the versioned `ep.v1` rail with that generation pinned beside the caller triple, and a connected client reads its generation from an issuer-written accepted row. A hosted workflow run is admitted under the starting caller's resolved ceiling, recorded once per run in a dedicated admission store the driver cannot write, checked before every channel effect (wait open, fetch, recorded re-read, conclave writes), and revoked by an independent create-only marker that ends open waits at their next poll and refuses resume, takeover and reconcile. `run-start` on the legacy rail is refused with `permission-denied` and the `ai.cotal.ep.unbound-caller-authority` detail. `cotal run start --local` takes `--admit-read` and `--admit-publish` (required) and `cotal run revoke <runId> --local --by <who> --reason <text>` writes the marker. Three new per-space stores (`cotal_issued_`, `cotal_accepted_`, `cotal_admission_`), immutable at the broker: the admission and accepted stores are write-once per key, the evidence store is append-only and read first-on-key, and all three refuse rollup headers, message deletes and purges, so a holder of its own key row can neither widen nor erase what was recorded. Two new one-shot profiles (`issuer`, `run-admitter`), an admission read on the run mediator and operator profiles, and `COTAL_ACCEPTED_TOKEN` on every connector's spawn environment. Breaking pre-1.0 authority change.

### Patch Changes

- 4b3881f: A workflow `sleep` that a busy host was simply too loaded to schedule no longer fails the run. A pause waits by reading the durable checkpoint plane, and each of those reads carries a client-side deadline that is itself a timer; when the machine is loaded hard enough that the run's process does not get back onto the CPU, that timer cannot run either, so it expires the moment the process resumes and reports a bare `timeout` even though the broker answered long ago. That was recorded as `L4000 EffectError: timeout`, which names the effect as the thing that broke and sends the author looking at their own program, and it killed runs whose only fault was being polite about load.

  The runtime now measures whether its own process was actually running across the wait, namely event-loop lag over the window together with a shortfall in the ticks that window should have contained, and treats a deadline that elapsed while the process was demonstrably off the CPU as a fact about the host rather than about the effect. The pause and its timer are durable, so the wait is simply re-entered and a `sleep` whose deadline passed during the starvation completes late, which is what a lower-bound wait promises. Nothing is widened and nothing is swallowed: a deadline on a loop that was running, and every failure that is not a client deadline, still fails immediately as `L4000` with its message intact. A host that still cannot serve the run after a bounded number of consecutive starved attempts fails under the new `L4025`, "Host did not schedule the run", quoting the lag and tick measurement it made, so a caller that genuinely cannot be served fails rather than hanging and the operator reads the real cause.

- Updated dependencies [a9c9849]
- Updated dependencies [b0aeca4]
- Updated dependencies [1469d18]
- Updated dependencies [348b8b7]
- Updated dependencies [9a334ae]
- Updated dependencies [18f3df0]
- Updated dependencies [9ff5c22]
- Updated dependencies [cf6ced5]
- Updated dependencies [36d1779]
- Updated dependencies [e3f2d21]
- Updated dependencies [062881a]
- Updated dependencies [159c5f0]
- Updated dependencies [c9ea091]
- Updated dependencies [5079c89]
- Updated dependencies [5395c7c]
- Updated dependencies [6fd855f]
- Updated dependencies [186fc62]
- Updated dependencies [1636927]
- Updated dependencies [dd6fea0]
- Updated dependencies [4b3881f]
- Updated dependencies [6fb1d64]
- Updated dependencies [b00f3c1]
- Updated dependencies [13f29e1]
  - @cotal-ai/core@0.49.0
  - @cotal-ai/workspace@0.49.0
  - @cotal-ai/lang@0.49.0

## 0.48.2

### Patch Changes

- @cotal-ai/core@0.48.2
- @cotal-ai/workspace@0.48.2
- @cotal-ai/lang@0.48.2

## 0.48.1

### Patch Changes

- 9a8a2a6: Inspect version-2 workflow journals on the compiled engine when planning forks and migrations. Preserve recorded pins, stop before new effects, and retain divergence and branch-refusal details across the worker boundary. Fork cuts remain fixed through catch and finally blocks, and inspection leaves pending broker effects untouched.
- Updated dependencies [9a8a2a6]
  - @cotal-ai/lang@0.48.1
  - @cotal-ai/core@0.48.1
  - @cotal-ai/workspace@0.48.1

## 0.48.0

### Minor Changes

- b6c843f: Restrict workflow driver credentials to their own journal and record writes. Move effects and leader reads onto a separate trusted host connection, with journal ownership checks, cancellation cleanup checks, and host-held wait acknowledgements. Hosted and local runs use this split; authenticated local runs now require a recorded space signer rather than a single credentials file.

  Custom run hosts must accept the separate mediator connection. Seat-adopting effect hosts must implement `restoreMigratedSeats` so migration reads stay on the host.

  Preserve settled parent history when a version-1 fork resumes through the host, without granting the child access to parent checkpoint tokens.

### Patch Changes

- Updated dependencies [b6c843f]
  - @cotal-ai/core@0.48.0
  - @cotal-ai/workspace@0.48.0
  - @cotal-ai/lang@0.48.0

## 0.47.1

### Patch Changes

- @cotal-ai/core@0.47.1
- @cotal-ai/workspace@0.47.1
- @cotal-ai/lang@0.47.1

## 0.47.0

### Patch Changes

- 8ec22cb: `cotal supervise` on a registered remote mesh now dials the broker URL the registry actually
  holds. A remote broker is commonly published over a `wss://` edge, and the manager-authority
  registration the supervisor runs first handed that URL to the raw node transport, which refuses a
  websocket URL outright, so supervision stopped before a manager was ever constructed. That
  registration and every other control dial this audit found can be handed a registry server URL now
  select the transport from the scheme, including the planes `cotal run --local` opens, which failed
  on such a mesh for the same reason. The registration also carries the record's TLS requirement
  instead of assuming a plaintext broker, so a participant no longer downgrades its prepare
  credential exchange on a mesh the registry describes as TLS-required. On the same path, the cluster
  artifacts the registration reads back are now looked up by the key form the content-addressed store
  uses, which a remote registration reached with a prefixed digest reference and could not resolve.
  - @cotal-ai/core@0.47.0
  - @cotal-ai/workspace@0.47.0
  - @cotal-ai/lang@0.47.0

## 0.46.0

### Minor Changes

- 18a0024: The manager hosts workflow runs. `run-start`, `run-resume`, `run-answer`, `run-status` and
  `run-ps` are served on the manager's endpoint rails; a run is validated before anything is
  recorded, driven in the manager's process under a per-run `run-driver` credential, and taken back
  from its journal after a manager restart. `cotal run` is a client of that surface by default,
  with `--local` keeping the in-process drive, now under the run's own `run-driver` and
  `run-operator` credentials rather than `admin`; an answer's writes are pinned to the one pause it
  answers. A user-auth mesh refuses the family by name until a run can carry its user's owner. A new `run` capability mints the family into an
  agent's credential and injects the `cotal_run` tool, so an agent can write a cotal-lang program
  and start it from a session. `run-answer` records the answerer from the caller's credential and
  takes no `by`; `cotal run answer` drops `--by` on the hosted path. `spawn({ supervise })` is a restart policy the manager enforces in
  place: `{ restarts, window? }` (default `10m`) until the budget is spent, then the seat is
  retired and the next `turn` is L4002. A policy this host cannot honour is refused at accept.

### Patch Changes

- Updated dependencies [9d745af]
- Updated dependencies [18a0024]
  - @cotal-ai/core@0.46.0
  - @cotal-ai/workspace@0.46.0
  - @cotal-ai/lang@0.46.0

## 0.45.0

### Patch Changes

- Updated dependencies [299a353]
- Updated dependencies [38d7bb7]
  - @cotal-ai/core@0.45.0
  - @cotal-ai/workspace@0.45.0
  - @cotal-ai/lang@0.45.0

## 0.44.0

### Patch Changes

- @cotal-ai/core@0.44.0
- @cotal-ai/workspace@0.44.0
- @cotal-ai/lang@0.44.0

## 0.43.0

### Patch Changes

- Updated dependencies [890d08a]
- Updated dependencies [e5412a1]
- Updated dependencies [7ff0c21]
  - @cotal-ai/core@0.43.0
  - @cotal-ai/workspace@0.43.0
  - @cotal-ai/lang@0.43.0

## 0.42.0

### Minor Changes

- a87709c: Every cotal-lang effect now performs on the mesh: the durable-action group is built end to end and
  the not-yet-durable seam is gone.

  `spawn` submits a real manager goal and returns the allocated seat's handle, and meters the
  agent's `permits` (`turns`, `wallClock`; the turn that would exceed one is L4001, and a budget the
  host cannot meter is refused at spawn); `conclave` opens a scoped sub-team as durable membership
  rows; `ask` parks schema-checked pauses answered through `cotal run answer` and tells the agent
  over the turn relay, one relay per attempt carrying the schema, the attempt and the previous
  refusal, which every connector's intake renders with the answer command; `monitor` registers the
  handle on its journal entry and `wait(down)` reads a monitored incarnation's death off presence
  liveness, refusing an agent nobody monitored.
  `turn` rides a new pull-shaped manager relay: the manager serves `turn` (targeted, the
  despawn/input reach) plus `turn-pending` and `turn-yield` (self reach, manager contract revision
  10), holds the payload on the goal-index note, pins the goal to the seat's incarnation, and denies
  at a goal-bound deadline hold; the seat side (all connectors) pulls pending turns, surfaces them
  two-phase into host context, auto-yields `done` when the host turn ends, and yields `blocked` or
  `handoff` through the new `cotal_yield` tool; the run client renders context with pending notices,
  arms its own pause on the acceptance's deadline as the L4003 authority, watches presence as the
  L4002 authority (a death the manager marks on the deadline terminal reads the same way), and
  honors handoffs (L4005/L4004 validation, the `handoffFrom` goal chain); the manager shows a seat
  one turn at a time. The relay holds on an auth mesh: the agent baseline gains the self-mode
  `turn-pending` and `turn-yield` rows, the operator seat-write set (`control-caller-admin`, the
  `admin` capability) gains `turn` beside `input`, and the manager mints the deadline hold's
  schedule over its serve connection and owner-expires the hold once due instead of reading a
  fire it holds no grant for. `wait(replied)` observes the run's own turn terminals as a level, and never a
  turn the run itself ended without an accepted yield. A `spawn` may bind a logical worktree: the
  validator rejects two literal-worktree spawns in one concurrent scope (L3022, named branch
  functions included) and the runtime claims a tree before it submits, refusing a second spawn into
  a tree held by a live seat or by a spawn in flight (L4008), with sequential reuse the moment the
  holder's presence lapses. A spawn refused at accept is L4000 (L4001 for seat capacity) and one
  whose seat never came up is L4002; an `ask` whose deadline passes with no conforming record is
  L4006; a fork copies a spawn that said `onFork: "adopt"` and refuses one that would have to
  respawn (L5019). The run driver re-issues
  recorded-but-undischarged cancellations at adoption, so recovery does not wait for completion to
  release a dead loser's seat, pause, or tree. A migration's `--adopt <handle>` hands the orphaned
  seat to the edited program's next spawn of that persona, and `--release <handle>` despawns it at
  commit through the run's own discharge; both name the agent the step spawned, and a spawn that
  produced none is an orphan like a sleep; the adopting spawn binds the orphaned spawn's goal as
  its own, so a resume re-reads the seat and a cancellation despawns it. A turn accept the manager
  cannot finish unwinds to a failed terminal on its bound goal, and a retry of it is refused naming
  that terminal. The delivery daemon hosts the checkpoint timer writer, so mediated deadlines fire
  with no suite pump.

### Patch Changes

- Updated dependencies [a87709c]
  - @cotal-ai/lang@0.42.0
  - @cotal-ai/core@0.42.0
  - @cotal-ai/workspace@0.42.0

## 0.41.4

### Patch Changes

- @cotal-ai/core@0.41.4
- @cotal-ai/workspace@0.41.4
- @cotal-ai/lang@0.41.4

## 0.41.3

### Patch Changes

- Updated dependencies [436f7d4]
  - @cotal-ai/core@0.41.3
  - @cotal-ai/workspace@0.41.3
  - @cotal-ai/lang@0.41.3

## 0.41.2

### Patch Changes

- @cotal-ai/core@0.41.2
- @cotal-ai/workspace@0.41.2
- @cotal-ai/lang@0.41.2

## 0.41.1

### Patch Changes

- @cotal-ai/core@0.41.1
- @cotal-ai/workspace@0.41.1
- @cotal-ai/lang@0.41.1

## 0.41.0

### Patch Changes

- Updated dependencies [de258fb]
- Updated dependencies [42d80da]
- Updated dependencies [bac1e00]
- Updated dependencies [5ec7feb]
  - @cotal-ai/core@0.41.0
  - @cotal-ai/lang@0.41.0
  - @cotal-ai/workspace@0.41.0

## 0.40.0

### Patch Changes

- @cotal-ai/core@0.40.0
- @cotal-ai/workspace@0.40.0
- @cotal-ai/lang@0.40.0

## 0.39.1

### Patch Changes

- @cotal-ai/core@0.39.1
- @cotal-ai/workspace@0.39.1
- @cotal-ai/lang@0.39.1

## 0.39.0

### Minor Changes

- 2277e28: A capability refusal is durable and retryable. A handler that cannot perform an effect on its host
  throws the new `EffectRefused`; the interpreter settles the entry with the new status `refused`
  under the handler's code (L5016 for the mesh handler's `NotYetDurable`, which now extends it) and
  unwinds the run with the uncatchable `RunHeld` (L5025). The driver grades the run `released`, and a
  resume on a capable host finds the new `refused` lookup verdict and performs the step live, so a
  run started before the durable-action surface lands heals the day it does. Previously the refusal
  settled `failed` and a resume replayed the failure forever.

  Two concurrent `turn`s on one agent handle are serialized at the dispatch seam both engines share:
  the second begins when the first settles, in dispatch order. Turns on different handles are
  unaffected.

  A fork's child records its lineage: the run record's spec gains `forkedFrom` (`{ run, step }`,
  absent on runs started fresh), `commitFork` writes it with the spec, and `ForkCommitResult.
lineageRecorded` is now true.

  Spec: §6.5 (turn serialization), §9.2 (six uncatchables), §10.1/§10.7 (the `refused` status and
  verdict), §11.1, §11.3, Appendix A (+L5025), and SPEC.md §14.3 (`forkedFrom`).

- 43e1f7d: Simulator fidelity, ask schema enforcement, journal result bound, and the scope release law.

  The simulator is now discrete-event: timed effects park at their wake times and are delivered in
  wake order on one virtual clock, so concurrent branches accumulate the durations they wrote and a
  simulated race is decided by the same rule as a live handler (least recorded clock, ties by
  declaration order) instead of by the order effects were asked.

  The reference simulator enforces the ask schema shorthand (spec §6.5): a schema it cannot read is
  refused with the new L4022 rather than skipped, a non-conforming reply consumes one attempt, and
  exhausted attempts report L4006.

  A journal can be constructed with a result bound (`JournalInit.resultBytes`, plumbed through
  `DriveRequest.resultBytes`); a settled ok result over it is refused ahead of the settling append
  with L5006, which leaves the reserved list.

  A host release or refused append inside a parallel, race, fanOut or conclave no longer cancels
  sibling branches or settles their in-flight entries cancelled: the unwind propagates bare, the
  scope settles nothing, and a resume picks the run up exactly where the journal says it stopped.
  The old behavior permanently poisoned any run a driver stopped while an effect was in flight
  inside a scope.

- 34ff272: `cotal run`, the workflow-run operator surface, self-registered by `@cotal-ai/runtime` and composed
  into the `cotal` binary: `start --file <program>` drives a new run on the mesh handler, `resume
<runId> --file <program>` takes an existing run over and drives it to quiescence, `ps` lists an
  endpoint's run records (state, holder, journal high-water, fork lineage), `journal <runId>` prints
  the durable step journal, and `answer <runId> <stepKey> --by <who> [--value <json>]` resolves an
  open checkpoint through the run driver, presenting as the arming holder read back from the
  checkpoint record (resume is holder-bound). One raw connection per invocation against the resolved
  mesh target; the journal's result bound is taken from the broker's own max_payload.

  `docs/workflows.md` gains an "Operating a run" section, the connector docs bundle carries it, and
  every connector folds a workflow steer (`WORKFLOW_STEER`) into its agent instructions beside the
  mesh-first steer, so agents reach for a durable journalled run instead of improvising long
  coordination loops in their own context.

### Patch Changes

- Updated dependencies [2277e28]
- Updated dependencies [43e1f7d]
  - @cotal-ai/lang@0.39.0
  - @cotal-ai/core@0.39.0
  - @cotal-ai/workspace@0.39.0

## 0.38.0

### Patch Changes

- @cotal-ai/core@0.38.0
- @cotal-ai/lang@0.38.0

## 0.37.0

### Minor Changes

- 00ac9d9: manager: refuse a manager-role spawn of a persona without the spawn capability. A persona defined over the wire (`cotal_persona`) carries no `capabilities:` line (the write path is content-only by design), and `cotal_spawn` takes a free-form `role`, so a wire-defined persona could be spawned with `role: "manager"` and join presenting as a manager whose credential cannot reach the control plane, silently, until the seat first tried to seat a worker (issue #966). The manager now refuses that spawn at accept, before any provisioning, naming the remediation for both authors: an operator adds `capabilities: [spawn]` to the persona file; a peer-defined persona cannot declare capabilities and must ask an operator. The guard keys on the effective role (a spawn-time role override wins over the file's, mirroring existing precedence) and leaves every non-manager spawn untouched. `cotal_spawn`'s `role` argument documents the requirement. Capabilities remain non-declarable over the wire: the closed `define-persona` input schema is unchanged and still guarded by `smoke:persona-input-closed`.

### Patch Changes

- Updated dependencies [e5e68ed]
- Updated dependencies [c31de91]
- Updated dependencies [d4779db]
- Updated dependencies [6926b34]
- Updated dependencies [d2c0fd3]
- Updated dependencies [7e45495]
- Updated dependencies [135ddaf]
- Updated dependencies [e703873]
- Updated dependencies [6c1cefe]
- Updated dependencies [00ac9d9]
- Updated dependencies [b20644b]
- Updated dependencies [74c9a1b]
- Updated dependencies [bfd650c]
- Updated dependencies [e6c6947]
- Updated dependencies [b36bf50]
- Updated dependencies [3cc980d]
- Updated dependencies [0098000]
- Updated dependencies [d94b617]
- Updated dependencies [eb3b429]
- Updated dependencies [17046ac]
- Updated dependencies [b7b932e]
- Updated dependencies [8eff985]
- Updated dependencies [b88edd9]
- Updated dependencies [063151b]
  - @cotal-ai/core@0.37.0
  - @cotal-ai/lang@0.37.0

## 0.36.0

### Patch Changes

- Updated dependencies [7c5995b]
  - @cotal-ai/core@0.36.0
  - @cotal-ai/lang@0.36.0

## 0.35.0

### Patch Changes

- @cotal-ai/core@0.35.0
- @cotal-ai/lang@0.35.0

## 0.34.0

### Patch Changes

- Updated dependencies [22c3182]
  - @cotal-ai/core@0.34.0
  - @cotal-ai/lang@0.34.0

## 0.33.9

### Patch Changes

- @cotal-ai/core@0.33.9
- @cotal-ai/lang@0.33.9

## 0.33.8

### Patch Changes

- @cotal-ai/core@0.33.8
- @cotal-ai/lang@0.33.8

## 0.33.7

### Patch Changes

- Updated dependencies [576ac7d]
  - @cotal-ai/core@0.33.7
  - @cotal-ai/lang@0.33.7

## 0.33.6

### Patch Changes

- @cotal-ai/core@0.33.6
- @cotal-ai/lang@0.33.6

## 0.33.5

### Patch Changes

- @cotal-ai/core@0.33.5
- @cotal-ai/lang@0.33.5

## 0.33.4

### Patch Changes

- Updated dependencies [1858932]
  - @cotal-ai/core@0.33.4
  - @cotal-ai/lang@0.33.4

## 0.33.3

### Patch Changes

- @cotal-ai/core@0.33.3
- @cotal-ai/lang@0.33.3

## 0.33.2

### Patch Changes

- Updated dependencies [ffdde4d]
  - @cotal-ai/core@0.33.2
  - @cotal-ai/lang@0.33.2

## 0.33.1

### Patch Changes

- @cotal-ai/core@0.33.1
- @cotal-ai/lang@0.33.1

## 0.33.0

### Patch Changes

- Updated dependencies [ba74c84]
  - @cotal-ai/core@0.33.0
  - @cotal-ai/lang@0.33.0

## 0.32.0

### Patch Changes

- @cotal-ai/core@0.32.0
- @cotal-ai/lang@0.32.0

## 0.31.0

### Patch Changes

- Updated dependencies [4ef59c3]
  - @cotal-ai/core@0.31.0
  - @cotal-ai/lang@0.31.0

## 0.30.2

### Patch Changes

- @cotal-ai/core@0.30.2
- @cotal-ai/lang@0.30.2

## 0.30.1

### Patch Changes

- Updated dependencies [aea08f9]
  - @cotal-ai/core@0.30.1
  - @cotal-ai/lang@0.30.1

## 0.30.0

### Patch Changes

- Updated dependencies [0e673ff]
- Updated dependencies [569f4d3]
- Updated dependencies [b282f70]
- Updated dependencies [0323f5b]
- Updated dependencies [ef01887]
- Updated dependencies [196dddb]
  - @cotal-ai/core@0.30.0
  - @cotal-ai/lang@0.30.0

## 0.29.2

### Patch Changes

- Updated dependencies [8531c13]
  - @cotal-ai/core@0.29.2
  - @cotal-ai/lang@0.29.2

## 0.29.1

### Patch Changes

- @cotal-ai/core@0.29.1
- @cotal-ai/lang@0.29.1

## 0.29.0

### Patch Changes

- Updated dependencies [1f025c3]
  - @cotal-ai/core@0.29.0
  - @cotal-ai/lang@0.29.0

## 0.28.2

### Patch Changes

- Updated dependencies [53f66c2]
  - @cotal-ai/core@0.28.2
  - @cotal-ai/lang@0.28.2

## 0.28.1

### Patch Changes

- Updated dependencies [2a383fe]
  - @cotal-ai/core@0.28.1
  - @cotal-ai/lang@0.28.1

## 0.28.0

### Patch Changes

- Updated dependencies [09b6a3b]
- Updated dependencies [9216d21]
- Updated dependencies [86f6b10]
- Updated dependencies [a84cb62]
- Updated dependencies [e377c7b]
- Updated dependencies [44738b2]
  - @cotal-ai/core@0.28.0
  - @cotal-ai/lang@0.28.0

## 0.27.0

### Patch Changes

- @cotal-ai/core@0.27.0
- @cotal-ai/lang@0.27.0

## 0.26.0

### Patch Changes

- @cotal-ai/core@0.26.0
- @cotal-ai/lang@0.26.0

## 0.25.0

### Minor Changes

- 0471af2: The driver hosts the version-2 compiled engine: a fresh run is stamped language version 2 and executes on the engine in its own locked-down worker thread, while every version-1 record keeps replaying on the tree-walker and a record whose version the build does not serve keeps refusing by name (L5023). The engine gains a bridged handler route for hosts whose effect handler is a live object: the handler and the durable journal store stay in the host process, and the worker forwards the effect seam over a message port, so effects stay durable pending-before-effect and no socket or credential enters the isolate holding the program. Failures cross the thread boundary whole: an EffectError keeps its code, kind and detail, a release keeps its reason, and a lost journal is regraded as the class the driver's outcome contract names. A race loser's cancellation crosses the bridge and fires the host handler's signal while the effect is still in flight (a cancel aimed at an effect that already answered does not cross, which is the only time a handler could not act on one anyway). The driver also refuses a malformed run record by its own name: a `languageVersion` that is not a string is released as malformed before the engine table is consulted, instead of being misread as an unserved version. A stop check that throws inside the host's poll is re-raised as the run's fault on the caller's stack rather than escaping as an uncaught exception.
- dbeec0f: The language version belongs to the engine that runs a program, and a build declares which engines it hosts.

  There are two engines and now two versions: the tree-walker is language version `1` and stays the
  replay engine for every run recorded under it, and the compiled engine is version `2`, a different
  language rather than a faster one, since `log` is data there and refuses code, and a step is a
  transformed-site hit rather than a walker dispatch. `resolvePins` and `bindPins` take the version as
  an argument, so each engine stamps its own and compares against its own; `WALKER_LANGUAGE_VERSION`
  and `ENGINE_LANGUAGE_VERSION` are exported beside `LANGUAGE_VERSION`, which is an alias for the
  current language, the engine's.

  Bumping one shared constant was measured and is not available: the walker would stamp 2 and compare
  1, and every walker fresh-run-then-resume round trip fails. Leaving it at 1 while the engine speaks
  2 fails the other way, on records already written. Each engine stamping and comparing its own breaks
  neither.

  The run driver now holds a table of the versions this build hosts, ordered by declared precedence
  rather than by a string sort. A fresh run is stamped with the version of the engine that will
  actually execute it, and a record whose version no engine here serves is released by name with the new **L5023**,
  naming both the version it met and the set this build serves, with the run left untouched: nothing
  activated and nothing appended. It is released rather than failed or thrown, because a build that
  cannot host a language has observed nothing about the program.

  Migration: `resolvePins(options, now)` and `bindPins(recorded, options)` now require a third
  argument, the calling engine's version. Callers inside this repo pass their own; an external caller
  passes `WALKER_LANGUAGE_VERSION` to keep today's behaviour. Records do not cross between versions in
  either direction, which was already true and is now enforced by the engine that meets them.

### Patch Changes

- Updated dependencies [636b4b8]
- Updated dependencies [c83e600]
- Updated dependencies [b501ec5]
- Updated dependencies [a087c2b]
- Updated dependencies [0471af2]
- Updated dependencies [dbeec0f]
- Updated dependencies [d3553be]
- Updated dependencies [dc34423]
- Updated dependencies [0b602e4]
- Updated dependencies [34caaf4]
- Updated dependencies [445e110]
- Updated dependencies [8e38835]
- Updated dependencies [6959679]
  - @cotal-ai/core@0.25.0
  - @cotal-ai/lang@0.25.0

## 0.24.0

### Minor Changes

- b7cc4fa: Host a cotal-lang run on the mesh.

  `@cotal-ai/lang` gains the durability the language rested on but did not have: run pins with a
  run clock, scope journal entries that record a race's winner and its losers so a replay resolves
  the same arm, a refusal when a resume is handed a journal without the pins that decide it, and an
  effect ceiling read from the pins rather than a default.

  `@cotal-ai/core` gains the step journal's storage plane, the run record and its lease, the
  checkpoint answer record, and the notice and migration records.

  `@cotal-ai/runtime` is new: the mesh handler that performs a program's effects on the real planes
  (durable pauses on the checkpoint plane, event awaits over durable consumers, notices), the
  `RunDriver` the manager daemon hosts, journal-replay resume, migration onto edited source, and a
  fork that redoes work under a new run id. Effects that need durable actions refuse through one
  named seam rather than pretending to succeed.

### Patch Changes

- Updated dependencies [9939dcc]
- Updated dependencies [b7cc4fa]
  - @cotal-ai/lang@0.24.0
  - @cotal-ai/core@0.24.0
