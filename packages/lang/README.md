# @cotal-ai/lang

Cotal Lang, the workflow language a durable Cotal run executes: a small subset of JavaScript in
which every interaction with the world is one of a dozen effects and everything else is pure. This
package is the validator, the interpreter, the step journal, the effect interface a host
implements, and the simulator and dry run that exercise a program with no broker.

**Tier:** `packages/` (the standard). Depends on nothing else in the repo; it knows about effects,
not about NATS. The host that runs a program on the mesh is `@cotal-ai/runtime`.

The language is defined by [`spec/cotal-lang.md`](../../spec/cotal-lang.md) (normative; every
`js` block in it is validated by this package's surface suite) and its wire footprint by
[SPEC.md §14](../../SPEC.md#14-workflow-runs-v05). The guide is
[docs/workflows.md](../../docs/workflows.md).

## Use

```ts
import { validate, run, dryRun, SimHandler, Journal } from "@cotal-ai/lang";

const source = `
const builder = await spawn("builder")
const r = await turn(builder, { name: "build", deadline: "30m" })
log(r.status)
`;

validate(source);                       // throws LangErrors, every refusal with code, cause, fix

const script = { turns: { build: { status: "done", at: 1 } } };
const plan = await dryRun(source, script);   // what it would do, with no agent touched

const first = await run(source, { runId: "r-1", handler: new SimHandler(script) });
// first.journal.entries() is the step journal; first.pins is what a resume must be handed back.

const again = await run(source, {
  runId: "r-1",
  pins: first.pins,
  journal: new Journal({ run: "r-1", entries: first.journal.entries() }),
  handler: new SimHandler({}),          // nothing is scripted: every step replays
});
```

`run` performs effects through the `EffectHandler` you pass and records each in the `Journal`;
hand the same journal and pins back and the same program resumes. `SimHandler` scripts turns, asks,
checkpoints and events and refuses anything unscripted (L6001), so a simulation cannot silently
invent an answer.

## Suites

`pnpm test` in this directory runs every smoke: grammar, keys, journal, pins, scopes, sim,
interpret, fuel, dryrun, examples, options, notify-fact, migrate, semantics (the pure fragment
against node) and surface (the syntax table, the library tables, the reference's examples).
`smoke/mutations/*.json` are the `pnpm mutation-proof` targets.
