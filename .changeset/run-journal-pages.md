---
"@cotal-ai/core": patch
"@cotal-ai/manager": patch
"@cotal-ai/runtime": patch
---

`cotal run show` and `cotal run journal` read a run whose journal is larger than the broker's
payload limit. They read the journal from the manager in pages, each one reply, through a new
`journal: { offset }` input on `run-status` that answers the rows from that offset that fit, with
`journalTotal`. A record or a single row too large for one reply now refuses `UNSUPPORTED` and
names `cotal run journal <run-id> --local`, instead of failing with the broker's payload error.
