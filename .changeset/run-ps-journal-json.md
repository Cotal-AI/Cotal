---
"@cotal-ai/core": patch
"@cotal-ai/manager": patch
"@cotal-ai/runtime": patch
---

`cotal run ps` and `cotal run journal` take `--json`, hosted or `--local`: one JSON object per row per line on stdout, with the run header and errors on stderr, as `cotal ps --json` does for seats. A run row adds its pinned `startedAt` and the `programHash` of its recorded program. A step row adds its effect kind and name, the recorded status and error code, its start and end times, and for an open pause its deadline and the `onExpiry` a checkpoint was armed with, which a checkpoint now records on its pending entry. An unreadable revocation marker under `--json` prints its reason to stderr and exits 1. `run ps --local` now reads its rows through the same listing the manager answers `run-ps` with, so both paths print the same rows.
