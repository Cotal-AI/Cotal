---
"@cotal-ai/cli": patch
---

Credential joins now explain missing channel read grants and mismatched lifecycle UIDs separately.
The join reference includes the channel grants needed by its credential-minting example, and known
grant failures no longer point at the delivery daemon.
