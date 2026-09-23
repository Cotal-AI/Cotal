---
"@cotal-ai/cli": patch
---

`cotal agent-bearer` skips the connector-seed boot gate. The helper is exec'd by a spawned seat on every bearer refresh, so a seed store stamped newer than the invoking binary refused its boot before the token file was read and a live seat died at its token expiry, while a matching generation made the credential exchange write every connector payload into the operator-global store. The skip is by command name (like `ext root`), with no environment flag: the helper reads one 0600 token file, exchanges it and prints the bearer without consulting or mutating the store. The generation guard and the auto-seed on operator-facing commands are unchanged. Fixes #1857.
