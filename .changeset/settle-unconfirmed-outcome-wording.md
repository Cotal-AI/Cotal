---
"@cotal-ai/cli": patch
---

After an `up`, `team boot` or `down` that exited 3 with its outcome unconfirmed, the next `up` or `down` now warns that the earlier stack start or down ended with its outcome unconfirmed. It used to say an `up` was interrupted, which is still what it says after an operation that was interrupted.
