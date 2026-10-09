---
"@cotal-ai/workspace": patch
---

Moving a manager or auth-plane identity record from its older `.cotal/auth` place no longer follows a symlink at either place. A `.cotal/space.<hex>/` entry that linked to the older record read as the same record, so the move deleted the older regular file and left only the link, which every reader refuses. An older entry swapped for a link to a different record during the move could also pass as that record. Both cases now refuse as not a regular file and keep the older record.
