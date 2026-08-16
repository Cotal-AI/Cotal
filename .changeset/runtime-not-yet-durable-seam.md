---
"@cotal-ai/lang": minor
"@cotal-ai/runtime": minor
---

A durable run now refuses an effect whose substrate has not landed, by name, instead of failing as a
missing method.

`spawn`, `turn`, `ask`, `monitor` and `conclave` all address an agent handle, and only `spawn`
produces one, so the group is gated by a single subject rather than by five absences. Reaching one on
the mesh handler raises `NotYetDurable` carrying L5016, and the code is what survives the interpreter
into the journal — without it the entry would record "the handler broke" about a step nothing ever
attempted. The simulator still performs all five, so a program using them can be written, validated
and dry-run today.

Also fixes a code collision introduced with the migration orphan table: three of its refusals had
been given L5005, L5006 and L5007, which already mean a pending effect, an oversized result and a
lost lease. They are now L5013, L5014 and L5015, and the catalog carries all four new entries.
