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

Know the limit before you decide whether you have to act, and know it as a rule rather than as a
list, because the list keeps turning out to be longer than whoever wrote it thought. Excess-property
checking fires wherever the literal is written in a position that already has a contextual type from
`SimScript`: at the call, under an annotation, whether that is a `const`, a later assignment to an
annotated `let`, or an annotated parameter, and under `satisfies SimScript`. All of those are now
errors and all of them are a one-line deletion. Exactly two shapes escape, and they are the two where
the literal is typed BEFORE it ever meets `SimScript`: a value whose type is inferred first and only
then passed by name, and one put through an `as` cast. Those still compile with `at` present and
still have it discarded, silently, exactly as before. Measured across the whole repository at this commit that is
five sites, and three of them are in the runtime consumer rather than in this package's own tests,
so the discarded field is not confined to the package that defines the type. The type closes the
two idioms a new author reaches for first; it does not close the loophole.

Nothing about the value the simulator produces changes, because it was always stamped from virtual
time.

This is the whole of the shipped change. The rest of that work is test-tree only: the `packages/lang`
smoke files now typecheck under a check-only project, which is a gate, not a behaviour.
