---
"@cotal-ai/lang": minor
---

`SimScript.checkpoints` no longer accepts an `at`, because the simulator never honoured one.

`SimHandler.checkpoint()` has two return paths and both stamp `at: this.virtualNow`, so a value
written into a checkpoint script was required by the type and then discarded. The cost was not the
wasted field, it was that every fixture carried a timestamp that meant nothing and read to the next
author as though the simulator were using it.

The scripted type is now `Omit<CheckpointResultValue, "at">`.

Migration: a checkpoint script written as a fresh object literal in the call itself is now a type
error if it passes `at`. Delete the field.

Know the limit as a RULE rather than as a list of shapes. Three earlier versions of this note gave a
list, of one shape, then two, then two escapes, and every one of them was short. The rule: the error
fires exactly where `SimScript` is already the expected type of the literal you are writing, and
nowhere else. Where it fires, the fix is deleting one field.

Stated that way it reaches the shapes a list kept missing. Writing the literal at a call that takes a
`SimScript`, under a `SimScript` annotation on a `const` or on a `let` you assign later, in a
parameter declared `SimScript`, and under `satisfies SimScript` are all errors now. It also settles
what escapes without a second list: anywhere the literal is typed before it meets this type, or is
never measured against it at all. A value whose type is inferred and only then passed by name
escapes, so does one put through an `as` cast, and so does one handed to a parameter declared
`unknown`. That last one is how the three sites in the runtime consumer escape: their helper takes
`script: unknown` and casts inside, so their literal is never checked against `SimScript` at all.
All of those still compile with `at` present and still have it discarded, silently, exactly as
before. Measured across the whole repository at this commit that is **seven pre-existing consumer
fixtures**, and three of them are in the runtime consumer rather than in this package's own tests,
so the discarded field is not confined to the package that defines the type. Two of the seven are
worth naming, because a first count of this missed them and a second reader found them: the two
scripts in `packages/lang/smoke/differential.smoke.ts` sit in a corpus whose tuple declares that
slot as `object`, so they are never measured against `SimScript` at all. That is the third escape
this paragraph lists, and it is the one a count reaches for last, because the other two at least
name the type they slip past. An eighth literal with `at` exists at this commit and is deliberately
not one of the seven: this change adds it, in
`packages/lang/smoke/sim.smoke.ts`, as the cell that proves the implementation discards a scripted
`at` on both return paths. It escapes the same way, through a parameter declared `unknown`, which
is the point of it. The type closes the
two idioms a new author reaches for first; it does not close the loophole.

Nothing about the value the simulator produces changes, because it was always stamped from virtual
time.

One more shipped type, and it moves in the same direction: `EngineCtx.call` declared
`args: unknown[] | (() => unknown[])` while the implementation writes
`typeof args === "function" ? await args() : args`. An async thunk is accepted at runtime and the
engine suite passes one deliberately, to prove the arguments arrive as a list rather than as a
promise, so the declaration was the half that was wrong. It is now
`unknown[] | (() => unknown[] | Promise<unknown[]>)`. Nothing about what the engine accepts changes;
a caller that was already passing an async thunk stops needing a cast to say so.

Those two are the whole of the shipped change. The rest of that work is test-tree only: the
`packages/lang` smoke files now typecheck under a check-only project, which is a gate, not a
behaviour.
