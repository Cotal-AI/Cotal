---
"@cotal-ai/cli": patch
---

`cotal invoke --timeout <ms>` now sets one deadline for the whole call. The contract read, a `--name` lookup and the reply all spend from it, and the default stays 10000. The contract read used to wait a fixed 10 seconds whatever the flag said, so `invoke` of an endpoint nothing serves took 10 seconds with `--timeout 1000`, and a slow contract read was cut off at 10 seconds with `--timeout 20000`. That refusal keeps its `TARGET_UNAVAILABLE` code, message and `--json` shape, and now comes when the flag's deadline runs out.
