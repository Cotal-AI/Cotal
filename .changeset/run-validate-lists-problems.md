---
"@cotal-ai/runtime": patch
---

`cotal run validate`, `run plan` and `run simulate` list every problem in a program that does not validate: its code, title, position, cause and fix, as a hosted `run start` refusal lists them. They used to print only `the workflow is not valid cotal-lang` with no problem at all, and `--json` carried only each problem's code and span. The JSON envelope now carries the full problems under `result.problems`, beside the unchanged `SCHEMA_INVALID` refusal.
