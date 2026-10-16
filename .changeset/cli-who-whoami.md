---
"cotal-ai": minor
"@cotal-ai/cli": minor
---

Add `cotal who` and `cotal whoami`. `who` lists the live roster of the selected space with each participant's status, condition, activity, attention, harness, model and host, and whether a manager runs the seat; `--waiting` keeps rows that are waiting or report a condition and `--all` adds infrastructure endpoints. `whoami` reports the identity the CLI acts under in the selected space and what it may read, post and do, without connecting. Both write one structured document with `--json` and a plain report with `--plain`; a part they could not read makes the run `partial` (exit 4), and a roster the identity may not read is refused with `PERMISSION_DENIED`.
