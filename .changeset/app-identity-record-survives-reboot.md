---
"@cotal-ai/cli": patch
---

Retire a `cotal mcp` conversation identity that a restart of the computer ended.

On a local space, the record a connection needs to retire such an identity was kept in the temp directory, which a reboot clears. The identity's delivery and DM durables then stayed in the space for good and kept collecting channel posts. The record is now kept in the account's Cotal folder, and it holds the host process's start token, so a host pid reused after a reboot reads as gone. The next connection retires the identity. Records an earlier version left in the temp directory are still retired.
