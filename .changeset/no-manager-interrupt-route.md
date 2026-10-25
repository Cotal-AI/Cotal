---
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

An `up --no-manager` interrupted by a signal named bare `cotal up` as the way to finish or restart the stack, and so did the `cotal down --yes` that settled it, so following either added the manager the operator had left out. Both now name `cotal up --no-manager`. An interrupted plain `up` still names `cotal up`.
