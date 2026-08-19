---
"@cotal-ai/lang": minor
---

`SimScript.checkpoints` no longer accepts an `at`, because the simulator never honoured one.

`SimHandler.checkpoint()` has two return paths and both stamp `at: this.virtualNow`, so a value
written into a checkpoint script was required by the type and then discarded. The cost was not the
wasted field, it was that every fixture carried a timestamp that meant nothing and read to the next
author as though the simulator were using it. Main's own fixtures had already stopped supplying it,
which is why the type was contradicting the files it governed.

The scripted type is now `Omit<CheckpointResultValue, "at">`.

Migration: a checkpoint script that still passes `at` is a type error. Delete the field. Nothing
about the value the simulator produces changes, because it was always stamped from virtual time.

This is the whole of the shipped change. The rest of that work is test-tree only: the `packages/lang`
smoke files now typecheck under a check-only project, which is a gate, not a behaviour.
