---
"@cotal-ai/cli": patch
---

`cotal invoke` and `cotal endpoint invoke` now give a Next when their deadline runs out after the endpoint contract read and before the command is published. That failure, "the <n>ms --timeout ran out before the command was published", had no remedy. It now names the same longer `--timeout` as the failure during the contract read, such as `cotal invoke manager ps --timeout 10000`, and `--json` carries it as `error.remedy`. The code stays `OPERATION_FAILED`.
