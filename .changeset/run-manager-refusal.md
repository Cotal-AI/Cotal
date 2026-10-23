---
"@cotal-ai/runtime": patch
---

A hosted `cotal run` verb the manager refuses now reports the outcome and code as other commands do, with `--json` as one refusal envelope. `run show` of a run the manager holds no record of is `TARGET_NOT_FOUND`, exit 2, and names `cotal run ps`. It used to print `run status: …` on stderr, write nothing on stdout and exit 1.
