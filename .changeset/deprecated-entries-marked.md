---
"@cotal-ai/workspace": patch
"@cotal-ai/delivery": patch
---

`help --all` and the help of `supervise`, `deliver`, `auth-service` and `feedback-intake` now mark
each deprecated entry, with its removal release and the service preset that replaces it. They listed
the entries with no label, so only a run's warning said they were deprecated.
