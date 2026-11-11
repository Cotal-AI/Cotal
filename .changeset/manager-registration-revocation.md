---
"@cotal-ai/core": patch
---

Managers restart faster over slow broker links after many credential renewals.
Registration revokes independent credential rows in bounded concurrent batches, waits for every started write, and still requires complete revocation and verified eviction before publishing successor authority.
