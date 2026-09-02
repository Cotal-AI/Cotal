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
`migration` record with the actor's name on it.

**Fork** starts a new run from a named step of an old one, copying the prefix under the parent's
pins (seed included, so the copied history's pure draws are the same draws). The child is a new run
under a new id whose record names the parent and the cut step (`forkedFrom`); the parent is
untouched.

## Operating a run

`cotal run` is the operator surface over the driver. Every verb opens one connection to the
resolved mesh target (the usual `--space` / `--server` / `--creds` flags). `start`, `resume` and
`answer` drive and exit when the drive settles; `ps` and `journal` inspect and exit at once.
`start` mints the run id and prints it, and the record never takes a caller-supplied one.

```bash
cotal run start --file build.cotal.js                   # drive a new run; the minted id is printed
cotal run ps                                            # list run records: state, holder, lineage
cotal run journal run-3f2a90c41b7e0d5a6c884e19b02df4a1                      # print the durable step journal
cotal run resume run-3f2a90c41b7e0d5a6c884e19b02df4a1 --file build.cotal.js # take the run over and continue it
cotal run answer run-3f2a90c41b7e0d5a6c884e19b02df4a1 "/checkpoint:approve#0" --by dana --value '"yes"'
```

`start` and `resume` need `--file`: the record stores no source, so the caller supplies the same
program (handing an edited one is a migration decision, and the resume stops on the divergence).
A run whose step was refused (L5016) exits with code 2 and stays held; `resume` on a host that can
perform the step performs it live and continues from there. `answer` resolves an open checkpoint,
or an open `ask` attempt, through the run driver, presenting as the arming holder, with the
answerer's name on the record.
Checkpoint expiry rides the mediated timer writer, which the delivery daemon pumps on a live mesh;
on a bare broker a pause still resolves, it just cannot expire.

## What is on the wire

The run's wire footprint is [SPEC §14](../SPEC.md#14-workflow-runs-v05):

| Thing | Where | What it is |
| --- | --- | --- |
| the run | `run.<endpoint>.<runId>` record | the resolved **pins** (seed, logical epoch, budgets, language version) on the immutable half; holder, lease and `journalHigh` on the status half |
| the step journal | `WFJ_<space>` stream, one subject per run | append-only, no age eviction, no Direct Get; every append fenced by the run subject's own sequence; takeover is replay-then-activate |
| a checkpoint answer | `answer.<endpoint>.<token>.<answerId>` | the payload beside the one-use settle fact; the settle names the answer it accepted |
| a notice | `notice.<endpoint>.<runId>.<addresseeId>.<noticeId>` | one bounded decision told to one agent, rendered ahead of its next turn |
| a migration | `migration.<endpoint>.<runId>.<migrationId>` | the report and who applied it, keyed by the report's own digest |

A run's **driver** holds publish on only its own run's subject and its own replay durable, never
a space-wide grant.

## What ships today

The language, its validator, interpreter, simulator and dry run are `@cotal-ai/lang`
(`packages/lang`), usable in-process with your own effect handler and with no broker: `validate(src)`,
then `run(src, { runId, handler })`, and `resume(src, journal, { runId, pins, handler })` to pick a
run up from its journal (the package README has the snippet, with `SimHandler` as the handler). That
is the in-process route, yours to drive with your own handler; a run the driver starts executes on
the compiled engine, as the engine paragraph below says. The wire
substrate of §14 (the `WFJ_<space>` stream, the four record kinds, the activation barrier, the
per-run grants) is in `@cotal-ai/core`, and the run driver, journal store, migrate and fork are
`@cotal-ai/runtime` (`implementations/runtime`). On the mesh handler, `sleep`, `checkpoint`,
`wait(message(...))`, `wait(idle(...))`, `wait(down(...))`, `wait(replied(...))`, `notify`,
`spawn`, `conclave`, `ask`, `monitor` and `turn` are durable.
`spawn` is
the manager's spawn action submitted under the step's own identity: the goal binds under the step's
request id, so a resumed run re-attaches to the same seat instead of allocating a second one, a
failed or refused spawn is catchable as L4002 with the manager's recorded reason, and a spawn on a
race branch that loses is despawned by the run's own cancellation sweep. `conclave` joins its
members to a real channel as durable membership rows: the channel derives from the step's own
request id when the program names none (a program-named channel is borrowed, never torn down, and
a membership that predates the conclave survives its close), each member handle resolves to its
principal through the seat's own presence row (an absent member is catchable as L4002), and a
conclave cancelled on a losing branch is released by the same cancellation sweep. `ask` parks one
checkpoint-plane pause per attempt, answered through `cotal run answer` as a checkpoint is:
the shorthand of the language reference §6.5 is enforced (an unreadable schema is L4022), a
non-conforming answer costs one attempt and its refusal reason is recorded on the entry for the
answerer to read, exhausted attempts (default one) are the catchable L4006, and the one absolute
deadline for the whole ask elapsing is L4003. `monitor` registers interest in an agent, and the
registration is the journal entry itself: monitoring an agent that is already dead succeeds, and
the death is the wait's to observe. `wait(down(...))` reads that death off presence liveness, the
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
link and moves the run's conversation owner, a handoff to a name the run never spawned is the
catchable L4005, and one to a seat bound to a different worktree is L4004. The deadline elapsing
before any yield is the catchable L4003, held by the run's own pause as well as the manager's
goal-bound hold, so either side outliving the other still converges on the same answer. A seat
that dies mid-turn is read off its own presence row by the run itself and is the catchable L4002.
`wait(replied(...))` observes those turns from another branch: a completed turn is a reply, and
the wait resolves with the observation record (the handle, the yield's status and note, the
yield's own stamp). It reads as a level, the way `wait(down)` does: a reply that already exists
resolves the wait at once, and two replies resolve to the latest by the yield's stamp. A denied
or cancelled turn is never a reply, so an unanswered wait rides its own mediated timeout to
`null`, and a handle the run never spawned or turned refuses loudly, since only this run's turns
are observable.
A `spawn` may bind its agent to a **logical worktree** (`spawn("builder", { worktree: "wt-1" })`):
the handle carries the id, and the run enforces the one rule the language states about it: two
agents never share a worktree concurrently. The validator rejects the literal case up front
(L3022: two branches of one concurrent scope spawning into one literal worktree), and the runtime
guards the rest: a spawn into a tree whose recorded holder is still live on presence is the
catchable L4008, and the tree is reusable the moment that holder's presence row is gone, so a
discharged race loser or a crashed seat releases its tree with no bookkeeping. A turn handoff
across worktrees is the L4004 described above. Recovery keeps these honest: a resumed run
reseeds its roster, holders and handoff memos from its own journal, and the driver re-issues any
recorded-but-undischarged cancellation at adoption, before the engine performs a new step, so a
loser a crash left alive does not keep its seat or its tree while the resumed run works on.

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

**The engine needs node 22 or newer** and refuses below it with **L1000**, which is an
implementation limit and not a language error, so you will not find it in the catalog. It is a floor
rather than a warning because the engine's frame plumbing rests on `AsyncLocalStorage`, and 22 is
the lowest node it has been measured on. The walker has no such floor.
