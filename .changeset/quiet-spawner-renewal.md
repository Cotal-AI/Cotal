---
"@cotal-ai/auth": patch
"@cotal-ai/cli": patch
"@cotal-ai/core": patch
---

Seats running this release retry less often when their spawner loses its grant, and `cotal ps` and `cotal status <seat>` show the reason and recovery steps.
