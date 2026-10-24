---
"@cotal-ai/runtime": patch
"@cotal-ai/connector-core": patch
---

The receipt of a hosted `cotal run answer` and `cotal run amend` now names the step, the value it filed and the answer id, and says "no value; --value was not given" when no `--value` was passed. With `--json` the same is in `result.answer`, with `valueGiven`. Before, the receipt said only "Answer accepted", so an answer sent without `--value` settled the step with no value and nothing said so. The CLI reference now says what an answer without a value records.
