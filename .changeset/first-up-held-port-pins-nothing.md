---
"@cotal-ai/cli": patch
---

A first `cotal up` refused because another program held its port, such as a web server, still pinned the folder's stack to that address: `up --server` with a free port refused `CONFLICT` "a recorded stack is not moved to another address", and `down --yes` did not clear it. The refusal now comes before any broker instance is recorded, a broker start refused before its process launched no longer counts as a stack that ran, and the refusal's next step on a first start names another `--server`. The docs no longer say both that such a stack pins nothing and that it keeps its address.
