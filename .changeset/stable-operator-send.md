---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

Keep the signed sender principal stable across one-shot sends from the same OS login and host on a static-auth mesh. Each send retains a fresh, short-lived credential with the existing operator permissions. Explicit credentials and signed-in user identities are unchanged.
