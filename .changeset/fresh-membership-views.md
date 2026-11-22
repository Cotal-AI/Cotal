---
"@cotal-ai/core": patch
---

Durable channel posts and connection changes no longer trigger full membership registry scans when the registry is unchanged. The delivery daemon checks broker revisions and indexes channel, family, and principal memberships, while the membership feed reads only changed rows in normal operation.
