---
---

The 23 mutation configs whose `find` anchors no longer matched their target code after later fixes point at the current code again, so `pnpm smoke:mutation-fixtures` passes and each of those mutations reaches the code it guards. The sandbox-guard smoke reads the steps of `pnpm check` from its `scripts/check.mjs` argument list, so it finds the guard step again.
