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

Know the limit before you decide whether you have to act. Excess-property checking fires wherever
the literal takes its type from `SimScript`, which is two shapes and not one: written inline in the
call, and written under an explicit `SimScript` annotation. Both are now errors and both are a
one-line deletion. What it does NOT catch is a literal whose type is inferred first and only then
passed by name, or one put through a cast: that still compiles with `at` present and still has it
discarded, silently, exactly as before. Measured across the whole repository at this commit that is
five sites, and three of them are in the runtime consumer rather than in this package's own tests,
so the discarded field is not confined to the package that defines the type. The type closes the
two idioms a new author reaches for first; it does not close the loophole.

Nothing about the value the simulator produces changes, because it was always stamped from virtual
time.

This is the whole of the shipped change. The rest of that work is test-tree only: the `packages/lang`
smoke files now typecheck under a check-only project, which is a gate, not a behaviour.
