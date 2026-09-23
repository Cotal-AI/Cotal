---
"@cotal-ai/cli": patch
---

A seat restore moves an existing working tree aside by renaming it straight onto its timestamped superseded name, retrying with a suffix when the name is taken. The previous exclusive-create claim could never be redeemed on Windows, where a rename onto an existing directory is refused.
