---
"@cotal-ai/core": patch
"@cotal-ai/auth": patch
---

The docs now state the first process epoch. SPEC §13.7 and `docs/embedding.md` say that the first registration of an instance commits epoch 0, that epoch 0 is open and serving like any later epoch, and that each later start of the same instance commits the previous epoch plus one, so a consumer or sweeper never treats 0 as absent or not ready. `docs/embedding.md` also states that `awaitHostFence` takes any non-negative safe integer epoch, 0 included, and refuses any other value with `bad-request`. No behavior changes.
