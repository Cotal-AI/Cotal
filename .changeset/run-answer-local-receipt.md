---
"@cotal-ai/runtime": patch
"@cotal-ai/connector-core": patch
---

`cotal run answer --local` and `cotal run amend --local` now print the same receipt as the hosted path: the step, the value filed or that none was given, any artifact and the answer id, with `result.answer` under `--json`, and a Next of `cotal r show <run> --local`. Before, they printed the raw answer record as unlabelled JSON.
