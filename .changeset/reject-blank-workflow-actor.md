---
"@cotal-ai/cli": patch
"@cotal-ai/runtime": patch
---

Local `cotal run answer` and `cotal run amend` reject a whitespace-only `--by` before contacting the broker.
