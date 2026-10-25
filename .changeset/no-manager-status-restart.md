---
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

`cotal status` on a running stack started with `--no-manager` offered `cotal up --root <root>` to restart its stopped members when the only one was the manager record an earlier full `up` left, and on such a stack with a member really gone its restart dropped `--no-manager`. Following either started the manager. That record no longer counts as a stopped member, and the restart keeps `--no-manager`.
