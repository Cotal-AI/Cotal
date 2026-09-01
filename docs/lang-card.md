# The cotal-lang card

> **Reference** (informative) · **For:** people writing a cotal-lang program · **Normative:** [spec/cotal-lang.md](../spec/cotal-lang.md)

One page to write a correct workflow program. The normative reference is
[spec/cotal-lang.md](../spec/cotal-lang.md); this card compresses the parts programs get wrong
first. A program is one module of restricted JavaScript: no imports, no `class`, no `Promise`, no
host globals. Every effect is journalled under a step key, so a run can stop on any host and
resume on another with the recorded steps returning instantly.

## Effects

| Primitive | Call | Returns |
|---|---|---|
| `spawn` | `await spawn(persona, { name?, worktree?, join?, role?, permits?, supervise?, onFork? })` | agent handle |
| `turn` | `await turn(agent, { name, deadline? })` | `{ status: "done" \| "blocked" \| "handoff", to?, note?, at }` |
| `ask` | `await ask(agent, { name, schema, deadline?, attempts? })` | the record the agent published |
| `checkpoint` | `await checkpoint(name, prompt, { schema?, timeout?, onExpiry?, to? })` | see below |
| `sleep` | `await sleep("10m", { name? })` | `null` |
| `wait` | `await wait(event, { name?, timeout? })` | the event value, `null` on timeout |
| `notify` | `await notify(agents, fact, { name? })` | `null` |
| `monitor` | `await monitor(agent, { name? })` | `null` |

`parallel`, `race`, `fanOut` and `conclave` are the four concurrency scopes (below). Step names
are kebab-case; where the reference says a name is required, it must be a string literal. Option
bags are closed: an unknown key is refused (L3011) with the full signature in the answer.
Durations are a whole number and one unit: `"30s"`, `"10m"`, `"4h"`, `"2d"`.

## Results you branch on

A `turn` yields the agent's status. An `ask` yields the record the agent published. `schema` is
opaque to the language and its meaning is the handler's; no handler in the reference
implementation interprets it in this revision, so a program MUST NOT rely on a shape being
enforced. Where a handler does check, `attempts` bounds the non-conforming replies tolerated
before it fails with L4006. A `checkpoint` is a durable pause raced against a durable timer:

- resolved: `{ status: "resolved", value?, by?, at, artifact? }`
- expired with `onExpiry: "proceed"`, or after an `"escalate"` hop expires too: `{ status: "expired", at }`
- expired with the default `onExpiry: "fail"`: throws L4007

```js
const gate = await checkpoint("ship-gate", "Ship 1.4.0 to npm?", { timeout: "4h", onExpiry: "proceed" })
if (gate.status === "resolved") {
  log(gate.value, gate.by)
} else {
  log("expired, holding")
}
```

## The await rule (L2013)

A call that starts an effect must be awaited where it stands, returned, or passed as a branch
thunk to a scope. Anything else starts work nothing waits for, and the validator refuses it.

```js
// refused: L2013
const timer = sleep("10m")
```

Valid forms: `await sleep("10m")`, `return sleep("10m")` inside a function, or
`race({ timeout: () => sleep("10m"), reply: () => turnSomeone() })` as branch thunks. The same
rule covers user functions declared `async`.

## Concurrency

`parallel` and `race` take branches unevaluated, as a record of thunks. The record keys are the
branch keys and survive reordering; array branches are keyed by index, which shifts when you
insert one (warning L3023). `fanOut(items, fn, { name, key? })` runs `fn(item, index)` per item;
the branch key is `key(item)`, else the item's string `id`, else the fan-out is refused (L3021).

```js
async function review(pr) {
  const seat = await spawn("reviewer", { worktree: pr.id })
  return await turn(seat, { name: "review", deadline: "30m" })
}
const prs = [{ id: "pr-11" }, { id: "pr-12" }]
const results = await fanOut(prs, (pr) => review(pr), { name: "review-all", key: (pr) => pr.id })
log(results)
```

A branch may not write to anything born outside it. Return values from branches and read the
scope's result instead.

```js
// refused: L2032
let seen = 0
await parallel({
  a: async () => { seen = 1 },
  b: async () => { seen = 2 },
})
```

## Values across effects

A value that crosses an effect boundary is frozen on the way back: writing to it is L2031, so
copy it into a fresh record first. Effect arguments must have a canonical form: `undefined` or a
non-finite number inside one is L3041, a function is L3042. `json.stringify` is the canonical
form (sorted keys, no spaces), and it refuses what has no canonical form (L4016) rather than
dropping it.

## Top refusals

| Code | What it refuses | Write instead |
|---|---|---|
| L2013 | an effect call nothing awaits | `await` it, `return` it, or pass a thunk branch |
| L2032 | a branch writing outside itself | return from the branch, read the scope's result |
| L2031 | writing a value that crossed an effect | copy into a fresh record, then write |
| L2012 | a host global by name | the replacement in the message, e.g. `json.stringify` |
| L2011 | `Promise` | the four scopes |
| L1025 | `==`, `!=` | `===`, `!==` |
| L1001 | `class` | records and functions |
| L4018 | a record, array or function where a primitive is needed | convert explicitly |
| L3013 | a computed step name where a literal is required | a string literal |
| L3011 | an unknown option key | the signature in the refusal |

Every code has a row in the reference's Appendix A, and the message a refusal prints is that
row's title, so search the reference for it verbatim.
