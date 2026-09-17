---
"@cotal-ai/core": patch
"@cotal-ai/runtime": patch
---

`cotal run journal` renders an expired checkpoint differently from an answered one. A settled
checkpoint's status is `ok` whether its pause was answered or expired, and the journal render took
the status, so both read `ok` and an operator could not tell an unanswered human gate from a
timeout. The render now reads the disposition the settle named (`resolved` / `expired`) from the
settled result, in both the `--local` journal path and the hosted status view, and keeps the
settled status for steps whose result is not a checkpoint disposition.
