---
"@cotal-ai/delivery": minor
"@cotal-ai/cli": minor
---

Return one JSON receipt from `cotal deliver pending --json`, including candidate IDs and not-found refusals.
The retained spelling uses the `cotal pending` reader, its bounded limits and its exit codes.
Read facts and candidates from `result` instead of the old first-line object and trailing text.
Plain output is unchanged.
Inspection skips connector installation, and parser refusals remain structured when value-taking
options precede the pending mode. Receipts consistently name the invoked command.
