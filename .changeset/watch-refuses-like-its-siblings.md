---
"@cotal-ai/cli": minor
---

`cotal watch` refuses a target it cannot open the way the other reads of that space do.

In a stopped project it ended on one line with exit 1, no mesh heading and no next step, while `history`, `channel` and `chat` in the same folder refused the same target with the full report and exit 2. It now refuses under the refusal's own code with that report, and `--json` carries that code, message and next step in the stream's `error` record instead of a generic sentence under `OPERATION_FAILED`.
