---
"@cotal-ai/lang": patch
---

A `conclave` body may no longer write a binding declared outside it, or a field of a record or array built outside it (L2032), on both engines, as `once` already could not. A settled `conclave` is replayed from its journal entry without entering its body, so the write happened on the live run and never on resume: the resumed run read the old value and diverged at the next effect that took it as input. Return the value from the body and assign the scope's result instead.
