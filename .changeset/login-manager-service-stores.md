---
"@cotal-ai/auth": patch
"@cotal-ai/workspace": patch
---

Signing in refreshes matching Manager service sign-ins on the same machine with the same approval. Service stores are checked for ownership, provider and account before their private session is updated, and sign-in reports the services it refreshed.
