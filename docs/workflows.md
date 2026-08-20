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
language hashes it and gives it no meaning, and no handler in this repository enforces one yet);
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
  scripted handler and **dry-run** to a plan before it touches an agent. One thing to know about the
  simulator: it advances a single virtual clock in the order effects are asked, so under it a `race`
  is decided by that order and declaration order, not by the durations you wrote (a `sleep("1h")` arm
  declared first beats a `sleep("1m")` arm declared second). That is the simulator, not the rule; on
  a live handler each arm's clock is the wall time its effects ended.

Full rules, with every code: [`spec/cotal-lang.md`](../spec/cotal-lang.md).

## Resume, migrate, fork

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
under a new id, and this revision records no lineage on it; the parent is untouched.

## What is on the wire

The run's wire footprint is [SPEC §14](../SPEC.md#14-workflow-runs-v05):

| Thing | Where | What it is |
| --- | --- | --- |
| the run | `run.<endpoint>.<runId>` record | the resolved **pins** (seed, logical epoch, budgets, language version) on the immutable half; holder, lease and `journalHigh` on the status half |
| the step journal | `WFJ_<space>` stream, one subject per run | append-only, no age eviction, no Direct Get; every append fenced by the run subject's own sequence; takeover is replay-then-activate |
| a checkpoint answer | `answer.<endpoint>.<token>.<answerId>` | the payload beside the one-use settle fact; the settle names the answer it accepted |
| a notice | `notice.<endpoint>.<runId>.<addresseeId>.<noticeId>` | one bounded decision told to one agent, rendered ahead of its next turn |
| a migration | `migration.<endpoint>.<runId>.<migrationId>` | the report and who applied it, keyed by the report's own digest |

A run's **driver** holds publish on exactly its own run's subject and its own replay durable, never
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
`wait(message(...))`, `wait(idle(...))` and `notify` are durable; `spawn`, `turn`, `ask`,
`monitor`, `wait(replied(...))`, `wait(down(...))` and `conclave` refuse with **L5016 (effect not
durable on this host)** until the durable action machinery they ride lands. That refusal is terminal
for the run that hits it: the step is recorded as attempted and failed, and a resume replays the
failure rather than retrying it, so a run started today does not heal the day those effects land. No
`cotal` command starts or resumes a run yet. Those are the next lanes, and this page will say so
when they change.

**Two engines, and which one runs your program.** The tree-walker is language version `1` and the
compiled engine is version `2`, two languages rather than two speeds of one (`spec/cotal-lang.md`
§8.4 lists what differs). The driver hosts both: **every run a driver starts is stamped `2` and
executed by the compiled engine** — the program runs in its own locked-down worker thread with
nothing in its global scope, while the effects and the durable journal stay in the driver's process,
bridged over a message port so no socket or credential enters the isolate holding the program —
and **every version-`1` record keeps replaying on the walker**, which is the walker's job. The
driver serves a declared set of versions, and a record whose version it does not serve is refused
by name (**L5023**) with the run left untouched, instead of being replayed by whichever engine
happens to be present. Records do not cross between versions in either direction; the repair is to
resume on the recorded version, or to fork.

**The engine needs node 22 or newer** and refuses below it with **L1000**, which is an
implementation limit and not a language error, so you will not find it in the catalog. It is a floor
rather than a warning because the engine's frame plumbing rests on `AsyncLocalStorage`, and 22 is
the lowest node it has been measured on. The walker has no such floor.
