---
"@cotal-ai/cli": patch
"@cotal-ai/web": patch
---

`cotal console` and `cotal join` now print a seat's harness-reported condition and its ages the way `cotal endpoints` and `cotal status` do. The console roster, NEEDS YOU rail and detail pane, the `--plain` line stream, and the `cotal join` presence lines, `Present:` line and `/who` show `waiting (rate_limit for 40m) · unchanged for 5s · active 40m ago` and the activity's `(set <age> ago)` instead of a bare `waiting`. The roster and each NEEDS YOU card put the status and these facts on rows of their own under the seat's name, wrapped to the pane's width at any terminal size, so neither a long name nor a narrow terminal cuts them and they no longer push the activity out of view. A seat that needs more rows than a short terminal leaves its pane takes the title's row and is cut at the bottom, keeping its name row, and Enter opens its detail pane with every fact. The console's ages use the shared compact format, so a heartbeat nine hours old reads `9h` rather than `540m`, and an age floors rather than rounds.
