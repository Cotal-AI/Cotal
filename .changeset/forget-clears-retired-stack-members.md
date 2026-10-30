---
"@cotal-ai/cli": patch
---

`space forget` now clears, in the root's stack journal, the instances of the stopped stack members it removes. Before, after `up`, `down`, `space forget` and `space create` in the same folder, `up --no-manager` carried the forgotten manager's instance, and `down` refused `TARGET_NOT_FOUND` and stopped nothing. An instance forget did not remove stays in the journal, and a journal an earlier release left that way is not changed.
