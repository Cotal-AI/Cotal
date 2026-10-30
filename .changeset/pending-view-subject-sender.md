---
"@cotal-ai/delivery": patch
---

Name each `cotal pending` candidate's `from` by the sender principal in its stored message subject, which the broker binds to the sender's credential, in both JSON and plain output. The sender ID written inside the message no longer appears there. A candidate whose subject cannot be parsed is withheld as unreadable.
