---
"@cotal-ai/runtime": patch
"@cotal-ai/connector-core": patch
---

Repeating `cotal run answer` right after it was accepted now gets the same `TARGET_NOT_FOUND` refusal as a later repeat, with a next step. Before, until the run recorded the first answer, a few seconds later, it got the checkpoint plane's raw conflict, with an opaque token, an epoch time and a spec section.
