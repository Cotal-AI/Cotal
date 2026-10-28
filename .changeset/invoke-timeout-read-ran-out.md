---
"@cotal-ai/cli": patch
---

`cotal invoke` and `cotal endpoint invoke` now say when their deadline ran out during the endpoint contract read. When the endpoint answered but the read did not finish in time, the call used to fail `OPERATION_FAILED` with "the endpoint contract read did not complete" and no Next. It now names the deadline, for example "the 100ms --timeout ran out during the endpoint contract read; no command was published", and its Next suggests a longer `--timeout`. The code, the exit status and the native `deadline-exceeded` cause in `--json` are unchanged. An endpoint nothing serves is still refused `TARGET_UNAVAILABLE`.
