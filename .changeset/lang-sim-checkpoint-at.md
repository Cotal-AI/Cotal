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

Know the limit before you decide whether you have to act, because it is narrower than it sounds.
Excess-property checking fires only on fresh literals, so a script assembled into a named `const`
and then passed by name, or passed through a cast, still compiles with `at` present and still has it
discarded, silently, exactly as before. Any fixture that assembles its script into a `const`, or
passes it through a cast, is in that position and this change leaves it alone. The type closes the
idiom that a new author reaches for first; it does not close the loophole.

Nothing about the value the simulator produces changes, because it was always stamped from virtual
time.

This is the whole of the shipped change. The rest of that work is test-tree only: the `packages/lang`
smoke files now typecheck under a check-only project, which is a gate, not a behaviour.
