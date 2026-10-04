---
"@cotal-ai/workspace": patch
"@cotal-ai/delivery": patch
---

`cotal deliver` takes `--root <dir>` to name the workspace root it serves instead of inheriting it from the working directory. Without the flag, a workstation daemon started from a directory with no `.cotal/` above it now refuses at start and names the directory it searched from. It used to read its credential and registry from that directory, dial the broker, and only then refuse on a missing `$SYS` observer. `@cotal-ai/workspace` adds `requireCotalRoot`, the same walk as `findCotalRoot` without the fallback to the start directory.
