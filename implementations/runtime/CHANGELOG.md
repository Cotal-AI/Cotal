# @cotal-ai/runtime

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
