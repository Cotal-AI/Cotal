---
"@cotal-ai/cli": patch
---

A foreground `cotal spawn` on a static-auth mesh now writes its creds to `<name>.<lifecycleUid>.creds` and the matching store key, as a manager's spawns do. It used to write `<name>.creds`, so a second spawn on the same name replaced the first one's creds, whichever exited first deleted the creds the other was still running with, and a standing `<name>.creds` from `cotal auth mint` was overwritten and then deleted. A spawn's exit or failed launch now removes only its own credential.
