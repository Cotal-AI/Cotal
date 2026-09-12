---
"@cotal-ai/lang": minor
"@cotal-ai/runtime": minor
---

Add `waitUntil(probe, { name, every, deadline })`: a durable wait on a resource the mesh does not own. Before this a program could only wait on a mesh event or on the clock, so blocking until something outside the mesh became true meant writing a poll loop, and a poll loop is broken across a resume: the probe's observation of "not yet" was journalled as the step's RESULT and replayed forever, so a resumed run was handed a stale answer for a resource that had since completed, and never looked again.

A `waitUntil`'s non-terminal observation is now journalled AS AN OBSERVATION and leaves the entry pending, so a resumed run re-observes the world. Only a terminal observation settles the entry, carrying its observation history beside the result. Each observation's probe is journalled in its own key namespace, so the effects one look performs can never be replayed as another look's answer. The deadline is absolute from the entry's start, so a crash does not buy the wait more time, and an elapsed deadline is catchable as `L4023` and reports how many times it looked. The handler is asked only to wait out the cadence: which resource to look at, and what counts as done, stay with the program. `every` and `deadline` are part of the step's identity, so editing either on a resumed run diverges; the predicate is not, so a program can correct it on a run that is already waiting. Neither `every` nor `deadline` may be defaulted, and a cadence longer than the deadline is refused at parse.

Journals written before this release are unaffected: the new entry shape adds an optional field, and no existing kind changes.
