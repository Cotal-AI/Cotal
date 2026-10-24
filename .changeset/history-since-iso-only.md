---
"@cotal-ai/cli": patch
---

`history --since` refuses a value that is not an ISO 8601 date or date and time, an age or a
sequence, naming the forms it takes. `--since=-5` and `--since 10/23/2026` were read as dates, and
`2026-02-30` rolled over into March, so the read went back further than asked.
