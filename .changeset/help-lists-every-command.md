---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
"@cotal-ai/connector-core": patch
---

`cotal help`, and `cotal --help` and `cotal -h` with it, now lists every command group under the entry screen, so no flag is needed to see what the CLI can do. Bare `cotal` keeps the compact entry screen and points to `cotal help` for the rest. `cotal help --all` is no longer needed; it still works and prints the same list. A hidden command, such as a deprecated daemon entry, is still left out of the list and still runs.
