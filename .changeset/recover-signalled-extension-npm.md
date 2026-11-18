---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

Allow connector repair and self-update after a direct npm child exits on a signal.
Keep ambiguous intermediary exits fail-closed, and discard an unpublished execution generation when the recovery snapshot refuses.
