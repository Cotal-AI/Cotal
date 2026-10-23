---
"@cotal-ai/cli": patch
---

A first `cotal up` that launched nothing no longer wedges its folder. When another NATS broker already answered at the address, the refused `up` left a stack journal that every later command treated as a stack that once ran: `up`, `up --server <other>`, `reset space` and `down --yes` all refused `LIFECYCLE_BLOCKED`. A journal whose members never launched now pins nothing. The next `up` plans a first start, at the same address once it is free or at another `--server`, and `down` reports that nothing runs there and exits 0. `reset space` and `reset store` refuse `TARGET_NOT_FOUND` and name `cotal up`, because no broker wrote a store.
