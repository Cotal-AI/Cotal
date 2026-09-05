# Workflow runs

> **Concept** (informative) · **For:** people writing a durable multi-agent workflow, and implementers hosting one · **Normative:** [SPEC §14](../SPEC.md#14-workflow-runs-v05) and the language reference [`spec/cotal-lang.md`](../spec/cotal-lang.md)

A **workflow run** is a program that coordinates agents over hours or days and survives the
process that started it. The program is written in **Cotal Lang**, a small subset of JavaScript in
which every interaction with the world is one of a dozen **effects** (`spawn`, `turn`, `ask`,
`checkpoint`, `sleep`, `wait`, `notify`, `monitor`, and the four concurrency scopes) and everything
else is ordinary, pure JavaScript. Every effect is written into the run's **step journal** before
it is performed and settled after, keyed by where in the program it happened rather than by when,
so a run that dies is resumed on any host by **re-running the program from the top** with recorded
effects returning their recorded results. Nothing about the interpreter is ever serialized: the
journal and the program are the whole state.

## A first program

```js
const planner = await spawn("planner")
const builder = await spawn("builder", { worktree: "wt-1" })

const plan = await ask(planner, { name: "plan", schema: { steps: "array" } })
const ok = await checkpoint("approve-plan", "Approve the plan?", { timeout: "4h", onExpiry: "proceed" })
if (ok.status !== "resolved") {
  await notify([planner], { decision: "approve-plan", outcome: "expired" })
}

const r = await turn(builder, { name: "build", deadline: "30m" })
if (r.status === "blocked") {
  await turn(planner, { name: "unblock" })
}

const outcome = await race({
  reply: () => wait(replied(builder), { timeout: "20m" }),
  giveUp: () => sleep("1h"),
}, { name: "await-or-move-on" })
log("outcome", outcome.index)
```

Read it as the flowchart it is. `spawn` brings agents in; `ask` is the narrow case where the
program itself needs a value (`schema` is a record the program hands the handler unchanged; the
language hashes it and gives it no meaning, and the handlers in this repository enforce it as the
shorthand of the language reference §6.5);
`checkpoint` is a durable pause a human resolves from anywhere, raced against a durable timer; `turn`
wakes an agent for one turn and returns how it yielded; `race` runs two branches and keeps the one
whose recorded clock is earliest. Agents talk to each other in channels as they always do; the
program never speaks in a channel, and the one thing it can put in front of an agent (`notify`) is a
bounded decision record, not prose.

## The mental model

- **Pure code is JavaScript.** Loops, records, arrays, closures, template literals, destructuring,
  `try`/`catch`, arithmetic, `switch`, compound assignment, optional chaining, spread and rest: what
  you would write anyway, with the parts that hide effects or make meaning depend on the host removed
  (`class`, `this`, `new`, `for...in`, `==`, labels, regex literals, `Math`/`Date`/`JSON`, promises,
  generators). Every refusal names its code and the edit that fixes it. The builtins are a short list
  (`keys`, `map`, `sort`, `json.stringify`, `now()`, `random()`), and arrays, strings and numbers
  answer their usual methods (`xs.map`, `s.trim()`, `n.toFixed()`) and nothing outside that table.
  Records and arrays you build are yours to change until they cross an effect boundary; a member you
  do not own, a host prototype, or a value another branch built is refused with a code, never a
  surprise.
- **Every effect is journalled and hashed.** A step is keyed `(scope path, kind, name, occurrence)`
  and its inputs are hashed. Reorder your program, add a step, rename a variable: recorded steps
  still match. Change what a step asks (a checkpoint's prompt, a sleep's duration, a turn's
  deadline) and the resume stops with a **divergence** naming the step, rather than replaying an
  answer to a question the program no longer asks.
- **Concurrency is visible.** `parallel`, `race`, `fanOut` and `conclave` are the only ways to do
  two things at once, each branch gets its own journal namespace, and the scope writes its own
  entry saying how it settled: which arm won a race is a recorded fact, decided by the arms'
  recorded clocks and declaration order, never by a scheduler. A branch may not write to anything
  declared outside it; return the value and read it out of the scope's result.
- **Time and randomness are tamed.** `now()` is the branch's run clock, the end of the last effect
  it awaited; `random()` is a seeded stream derived per scope. Both replay identically.
- **Values freeze at the boundary.** What crossed into or out of an effect is what the journal
  recorded, and it cannot change afterwards; build a new value.
- **The journal is the debugger.** Every entry carries its key, its inputs' hash, its outcome and
  its timing, and every error is in the program's own coordinates. A run can be **simulated** with a
  scripted handler and **dry-run** to a plan before it touches an agent. The simulator is
  discrete-event: timed effects park at their wake times and are delivered in wake order on one
  virtual clock, so concurrent branches accumulate the durations they wrote and a simulated `race`
  is decided by the same rule a live handler produces (least recorded clock, ties by declaration
  order). A `sleep("1m")` arm beats a `sleep("1h")` arm whatever their declaration order.

Full rules, with every code: [`spec/cotal-lang.md`](../spec/cotal-lang.md).

## Continuing a run

**Resume** is re-execution: the driver replays the journal, the program runs from the top, recorded
steps return instantly, and the first unrecorded step is performed live. It refuses a journal that
belongs to another run, a pin that differs from the recorded ones, and a different language version.

**Migrate** moves a run onto edited source. A dry walk of the new program over the recorded journal
finds every recorded step the edit changed (a divergence) and every one it no longer reaches (an
orphan), and the orphan table says what each means: a removed `sleep` is nothing, a removed `turn`
already happened, a removed `spawn` is a live agent you must adopt or release, a removed resolved
`checkpoint` is a human decision you must explicitly discard. The decision is filed as a
`migration` record with the actor's name on it. An adopted seat (`--adopt <name>#<uid>`) goes to
the edited program's next `spawn` of that persona, which returns the recorded handle and mints
nothing, so the agent keeps its identity, its worktree and its turn history across the edit. A
released seat (`--release <name>#<uid>`) is despawned when the migration commits, through the same
discharge a cancelled branch's seat leaves by, so the record never claims a release nothing did.
The spawn that adopts a seat binds the orphaned spawn's goal as its own, so a resume of that step
reads the same seat back and a cancellation of it despawns the seat it holds.

**Fork** starts a new run from a named step of an old one, copying the prefix under the parent's
pins (seed included, so the copied history's pure draws are the same draws). The child is a new run
under a new id whose record names the parent and the cut step (`forkedFrom`); the parent is
untouched. A spawn inside the copied prefix is honoured by its `onFork`: `"adopt"` copies it, and
the child shares the parent's agent (the manager shows that seat one turn at a time across both
runs); `"respawn"`, the default, would mint a fresh identity the copied turns do not address, so
this host refuses that cut (L5019) rather than rewriting the parent's history.

## Operating a run

The manager hosts runs. `cotal run start` hands the program to the manager of the resolved mesh
(the usual `--space` / `--server` / `--creds` flags), which validates it, mints the run id, drives
it in its own process, and answers with the id once the run is recorded. The terminal is free the
moment the id prints; the run continues on the manager through every pause, and a manager restart
takes back every run it had recorded running, from the journal, under the next epoch. `resume`
names a run the manager recorded and is refused while the manager is already driving it. `ps` and
`journal` read; `answer` resolves an open checkpoint, or an open `ask` attempt, from any terminal
or agent that holds the `run` capability.

```bash
cotal run start --file build.cotal.js                   # the manager starts it; the minted id is printed
cotal run ps                                            # list run records: state, holder, lineage
cotal run journal run-3f2a90c41b7e0d5a6c884e19b02df4a1                      # print the durable step journal
cotal run resume run-3f2a90c41b7e0d5a6c884e19b02df4a1                      # the manager takes the run back
cotal run answer run-3f2a90c41b7e0d5a6c884e19b02df4a1 "/checkpoint:approve#0" --value '"yes"'
```

A program that does not validate is refused before anything is recorded, with every problem in the
answer as the validator would print it. The driver records the program beside the run, so `resume`
takes the run id alone and the manager reads the source back; an edited program is a `migrate` or a
`fork`, never a resume. An answer is recorded under the answerer the manager knows from the
caller's credential: a managed agent by its name, anyone else by their principal. The request
carries no name. An agent with `capabilities: [run]` has the same five verbs as the `cotal_run`
tool ([MCP tools](mcp-tools.md)), so a program can be written and started from inside a session.
A `start` or `resume` answers once the run's record is written, within a bounded wait; a manager
that is still taking back a predecessor's runs at boot refuses both with `unavailable`, and a
retry a moment later is the whole remedy.

`--local` drives the run in this process instead: `start`, `resume` and `answer` exit when the
drive settles, `--by <who>` names the answerer, and `cotal run resume <runId> --local --file
<program>` is how a run with no recorded program, or a run on a bare broker with no manager, is
continued. On a static mesh the local drive mints the run's own credential from the folder's
trust material, so it runs from the mesh's project folder. A user-auth mesh runs no programs
yet, hosted or local: the manager refuses the family by name, since a hosted run's seats would be
spawned under the static owner, which a user mesh refuses, and a user bearer holds no run rows.
A run whose step was refused (L5016) stays held; a
resume on a host that can perform the step performs it live and continues from there.
`journal` prints what an open pause asks beneath its step key, which is the address `answer` takes
back. Checkpoint expiry rides the mediated timer writer, which the delivery daemon pumps on a live
mesh; on a bare broker a pause still resolves, it just cannot expire.

## What is on the wire

The run's wire footprint is [SPEC §14](../SPEC.md#14-workflow-runs-v05):

| Thing | Where | What it is |
| --- | --- | --- |
| the run | `run.<endpoint>.<runId>` record | the resolved **pins** (seed, logical epoch, budgets, language version) on the immutable half; holder, lease and `journalHigh` on the status half |
| the program | `program.<endpoint>.<runId>` record | the source the run was started from, verbatim, written once by the driver that pinned the run; what a resume reads and what a migration is measured against |
| the step journal | `WFJ_<space>` stream, one subject per run | append-only, no age eviction, no Direct Get; every append fenced by the run subject's own sequence; takeover is replay-then-activate |
| a checkpoint answer | `answer.<endpoint>.<token>.<answerId>` | the payload beside the one-use settle fact; the settle names the answer it accepted |
| a notice | `notice.<endpoint>.<runId>.<addresseeId>.<noticeId>` | one bounded decision told to one agent, rendered ahead of its next turn |
| a migration | `migration.<endpoint>.<runId>.<migrationId>` | the report and who applied it, keyed by the report's own digest |

A run's **driver** connects on a credential of its own, the `run-driver` profile, minted for one
run and one takeover attempt. Pinned to the run: publish on its own journal subject and its own
replay durable, its `run`, `program`, `notice` and `migration` records, the timer schedule at its
own instance and epoch, and the manager's lifecycle commands as the run's own caller. Wider than
the run, and named as the profile's residual: the checkpoint records and settle facts of the whole
endpoint (a pause is keyed by a token that does not exist at mint), the point reads of the records,
fact, timer and chat stores (a KV read is one verb on the whole backing stream, and a matched
message is re-read by sequence the same way), a wait's own durable on the chat stream (named per
step, so the consumer rows are stream-scoped), and the channel and membership registries a
conclave writes. It holds no consumer on the records store, so it lists its
notices and migrations by walking the store one message at a time, and it cannot speak on a
channel, read another run's journal, or file an answer. A served read rides a one-shot
`run-operator` credential minted for that one call, holding the records walk and the named run's
replay and nothing it can write. An answer is two such calls: the read that finds the open pause,
then a second credential minted for that pause's token alone, holding its answer record and its
checkpoint settle and no other pause's. `cotal run --local` mints the same profiles for itself on
a static mesh, one per connection.

## What ships today

The language, its validator, interpreter, simulator and dry run are `@cotal-ai/lang`
(`packages/lang`), usable in-process with your own effect handler and with no broker: `validate(src)`,
then `run(src, { runId, handler })`, and `resume(src, journal, { runId, pins, handler })` to pick a
run up from its journal (the package README has the snippet, with `SimHandler` as the handler). That
is the in-process route, yours to drive with your own handler; a run the driver starts executes on
the compiled engine, as the engine paragraph below says. The wire
substrate of §14 (the `WFJ_<space>` stream, the five record kinds, the activation barrier, the
per-run grants) is in `@cotal-ai/core`, and the run driver, journal store, migrate and fork are
`@cotal-ai/runtime` (`implementations/runtime`). On the mesh handler, `sleep`, `checkpoint`,
`wait(message(...))`, `wait(idle(...))`, `wait(down(...))`, `wait(replied(...))`, `notify`,
`spawn`, `conclave`, `ask`, `monitor` and `turn` are durable.
`spawn` is
the manager's spawn action submitted under the step's own identity: the goal binds under the step's
request id, so a resumed run re-attaches to the same seat instead of allocating a second one, a
failed or refused spawn is catchable as L4002 with the manager's recorded reason, and a spawn on a
race branch that loses is despawned by the run's own cancellation sweep. `permits` are the budgets
this host meters: `turns`, how many turns the run may dispatch to the agent, and `wallClock`, a
duration from the spawn after which no turn is admitted. The turn that would exceed one is the
catchable L4001 (kind `permit-turns` or `permit-wall-clock`; a deadline the remaining wall clock
cannot hold counts as exceeding it), an adopted run counts the turns its journal recorded, and a
budget the host has no meter for, such as `tokens` or `spend`, is refused at the spawn rather than
accepted and ignored. `supervise` is the restart policy this host asks the manager to enforce:
`restarts`, how many in-window process deaths may come back under the same handle, and `window`,
the duration those deaths are counted in (default `10m`). The manager restarts the process in
place under the same name, lifecycle uid, persona, worktree and permits; `monitor` does not fire
for a restart, and `wait(down)` fires only when the seat is gone for good. Spending the budget
retires the seat, and the next `turn` is the catchable L4002. A policy this host cannot enforce
(an unknown key, a user-mode seat, or a runtime that cannot respawn a name in place) is refused
at the spawn rather than accepted and ignored. `conclave` joins its
members to a real channel as durable membership rows: the channel derives from the step's own
request id when the program names none (a program-named channel is borrowed, never torn down, and
a membership that predates the conclave survives its close), each member handle resolves to its
principal through the seat's own presence row (an absent member is catchable as L4002), and a
conclave cancelled on a losing branch is released by the same cancellation sweep. `ask` parks one
checkpoint-plane pause per attempt, answered through `cotal run answer` as a checkpoint is, and
tells the agent through the same relay `turn` uses: one relay per attempt under the attempt's own
token, carrying the schema, the attempt count, the deadline and the previous refusal, which the
seat's connector renders as the record wanted and the command that answers it. An ask addresses
an agent the run spawned (anything else refuses before an attempt opens), a resumed attempt tells
the seat nothing twice, and a seat gone at the relay is L4002. On the pause itself:
the shorthand of the language reference §6.5 is enforced (an unreadable schema is L4022), a
non-conforming answer costs one attempt and its refusal reason is recorded on the entry for the
answerer to read, exhausted attempts (default one) are the catchable L4006, and so is the one
absolute deadline for the whole ask passing with no conforming record (its kind is `ask-deadline`).
`checkpoint` binds what it asks on its own entry, so `cotal run journal` prints the question under
the step key an answer is addressed by while the pause is open: the address alone left whoever was
asked reading the source to find out what "approve" meant. An `escalate` addressed to an agent this
run spawned is relayed to that seat through the same turn relay an `ask` uses, carrying the prompt
and the token to answer under; a `to` naming anyone else is a person, and their pause stays the
one anybody can answer, with the addressee recorded and rendered beside the question.
`monitor` registers interest in an agent, and the
registration is the journal entry itself, carrying the handle it registered: monitoring an agent
that is already dead succeeds, and the death is the wait's to observe. `wait(down(...))` observes
a monitored agent, and refuses one the run never performed `monitor` on. It reads the death off presence liveness, the
same witness a conclave join resolves members through: the value carries the handle, the reason
(`lapsed` when nothing live holds the name any more, `superseded` when a live row holds it under
a different incarnation) and the time of observation, a wait that begins after the death resolves
at once, and a timeout resolves null on one absolute deadline a resumed run re-attaches to.
`turn` wakes one seat for one host turn through the manager as a pull-shaped relay: the run
submits the turn under the step's own identity, the manager holds it as a goal pinned to the
seat's incarnation, and the seat pulls it under its own reach ahead of its next host turn, so
nothing is pushed into a session mid-thought. The payload the seat reads names the run and the
step and carries the rendered run context, plus any pending notices addressed to it, which the
turn consumes. The seat yields through `cotal_yield` (`done`, `blocked`, or `handoff` with an
addressee), and ending its host turn yields `done` for every turn it was shown. A `handoff` names
another seat the same run spawned: the next `turn` in the same scope to that seat records the
link, a handoff to a name the run never spawned is the catchable L4005, and one to a seat bound
to a different worktree is L4004. The deadline elapsing before any yield is the catchable L4003:
the acceptance names the instant, the manager's goal-bound hold denies at it, and the run arms its
own pause on that same instant, so either side outliving the other still converges on the same
answer. A seat that dies mid-turn is read off its own presence row by the run itself and is the
catchable L4002, and a death the manager marked on the deadline terminal reads the same way. Two
turns on one seat, from two branches or from two runs, reach it one at a time: the language
dispatches the second when the first settles, and the manager shows a seat the oldest unsettled
turn alone. On an auth mesh the relay needs no extra grant: every spawned seat's baseline
credential carries its own pull and yield rows, the run driver's operator instrument carries the
turn request, and the manager arms the deadline hold over its own serve grant and expires it
itself once due. An accept the manager cannot finish is unwound to a failed terminal on the goal
it bound, and a retry of that submission is refused naming the terminal rather than accepted a
second time.
`wait(replied(...))` observes those turns from another branch: a completed turn is a reply, and
the wait resolves with the observation record (the handle, the yield's status and note, the
yield's own stamp). It reads as a level, the way `wait(down)` does: a reply that already exists
resolves the wait at once, and two replies resolve to the latest by the yield's stamp. A denied
or cancelled turn is never a reply, so an unanswered wait rides its own mediated timeout to
`null`, and a handle the run never spawned or turned refuses loudly, since only this run's turns
are observable. A turn the run itself ended without an accepted yield (its deadline, a
cancellation, a refused handoff) is never a reply, whatever the seat yields to the relay later.
A `spawn` may bind its agent to a **logical worktree** (`spawn("builder", { worktree: "wt-1" })`):
the handle carries the id, and the run enforces the one rule the language states about it: two
agents never share a worktree concurrently. The validator rejects the literal case up front
(L3022: two branches of one concurrent scope spawning into one literal worktree, named branch
functions included), and the runtime guards the rest, computed ids included: a spawn claims its
tree before it submits, so a second spawn into a tree held by a live seat or by a spawn still
bringing one up is the catchable L4008, a spawn that ends without a handle gives the tree back,
and the tree is reusable the moment a holder's presence row is gone, so a discharged race loser
or a crashed seat releases its tree with no bookkeeping. A spawn the endpoint refuses at accept
is the catchable L4000 (L4001 when the refusal is the endpoint's seat capacity), and one whose
seat never came up is L4002. A turn handoff across worktrees is the L4004 described above. Recovery keeps these honest: a resumed run
reseeds its roster, holders and handoff memos from its own journal, and the driver re-issues any
recorded-but-undischarged cancellation at adoption, before the engine performs a new step, so a
loser a crash left alive does not keep its seat or its tree while the resumed run works on. The
same sweep withdraws a cancelled branch's undelivered notices: a notice waits on the run for its
addressee's next turn, so a decision the run cancelled would otherwise arrive at an agent with
nothing to distinguish it from one that stood.

Every effect the language defines performs on the mesh handler; nothing is refused as
not-yet-durable any more. The operator surface over the driver is `cotal run`; the section above has the verbs.

**Two engines, and which one runs your program.** The tree-walker is language version `1` and the
compiled engine is version `2`, two languages rather than two speeds of one (`spec/cotal-lang.md`
§8.4 lists what differs). The driver hosts both: **every run a driver starts is stamped `2` and
executed by the compiled engine**. The program runs in its own locked-down worker thread with
nothing in its global scope, while the effects and the durable journal stay in the driver's process,
bridged over a message port. No socket or credential enters the isolate holding the program,
and **every version-`1` record keeps replaying on the walker**, which is the walker's job. The
driver serves a declared set of versions, and a record whose version it does not serve is refused
by name (**L5023**) with the run left untouched, instead of being replayed by whichever engine
happens to be present. Records do not cross between versions in either direction; the repair is to
resume on the recorded version, or to fork.

**The engine needs node 22 or newer** and refuses below it as `EngineUnavailable`, which is an
implementation limit and not a language error: it carries no `L` code, so there is nothing to look
up in the catalog. It is a floor rather than a warning because the engine's frame plumbing rests on
`AsyncLocalStorage`, and 22 is the lowest node it has been measured on. The walker has no such floor.
