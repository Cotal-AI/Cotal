---
"@cotal-ai/workspace": patch
"@cotal-ai/manager": patch
---

The auth plane's instance identity file and the remote manager's authority state file now take their names from `spaceKey`. They used to hex-encode the space themselves, so an empty space wrote `auth-instance..json` or `remote-manager..json`, and a space holding an unpaired surrogate shared a file with the space named `U+FFFD`: the second auth plane adopted the first one's identity, and the second remote manager was refused as malformed. Both names are now refused before an identity file is written. A valid space keeps the same file name, so nothing on disk moves.
