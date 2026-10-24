---
"@cotal-ai/cli": patch
---

The team reports leave out rows that do not apply. `team check`, `team deploy --dry-run` and
`team boot --dry-run` print "Durable delivery on open" only for an open space, and `team check`
says "No agents declared." instead of an empty agent table. The deploy preview's TLS row reads
`required` or `not required`, as `team show` does, instead of "not recorded required".
