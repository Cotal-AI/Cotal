---
"@cotal-ai/runtime": patch
---

`cotal run ps` and `cotal run journal` take `--json`, hosted or `--local`: one JSON object per row per line on stdout, with the run header and errors on stderr, as `cotal ps --json` does for seats. `run ps --local` now reads its rows through the same listing the manager answers `run-ps` with, so both paths print the same rows.
