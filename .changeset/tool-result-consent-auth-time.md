---
"@cotal-ai/auth": patch
---

A tool-result consent now refuses an IdP `auth_time` that is in the future, given in milliseconds, or not a non-negative integer number of seconds. Before, such a time passed the five-minute freshness check and was signed as a proof taken at the moment of signing.
