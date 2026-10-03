---
"@cotal-ai/workspace": patch
"@cotal-ai/manager": patch
"@cotal-ai/delivery": patch
---

CLI output is plain text when stdout is not a terminal or `NO_COLOR` is set to a non-empty value. The shared color helpers used to wrap every string in ANSI escapes, so `cotal --help`, `cotal status`, `cotal meshes` and the red error lines on stderr carried escapes into pipes and log files. The manager's and the delivery daemon's own always-on copies are gone; `cotal supervise` and `cotal feedback-intake` now print through the same helpers. `FORCE_COLOR` turns color back on even when output is piped, unless it is `0` or `false`, and it takes precedence over `NO_COLOR`, the order Node uses.
