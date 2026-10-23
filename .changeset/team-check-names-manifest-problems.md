---
"@cotal-ai/cli": patch
---

`team check`, `team boot` and `team deploy --dry-run` now name each manifest problem by file, line,
key and reason, and `--json` lists them under `target.issues`. An alias bomb is reported as a
manifest problem. Before, every mistake gave one identical sentence.
