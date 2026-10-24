---
"@cotal-ai/cli": patch
---

`cotal history --creds` with an agent credential now reads the channels its grant names. It used to try the multi-channel read only observer and admin credentials may make, and refused with "may not read #general" although the credential's ACL named #general. An agent credential now reads one channel at a time under the lifecycle its own history grant names, as a user-auth identity does. A channel the grant leaves out is refused with the channels it does name, and DM history and `--since` by sequence are refused for it.
