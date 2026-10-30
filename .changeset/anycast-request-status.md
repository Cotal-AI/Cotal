---
"@cotal-ai/core": minor
"@cotal-ai/connector-core": minor
"@cotal-ai/connector-claude-code": minor
"@cotal-ai/connector-codex": minor
"@cotal-ai/connector-jcode": minor
"@cotal-ai/connector-opencode": minor
"@cotal-ai/pi": minor
"@cotal-ai/cli": minor
---

Anycast requests get a receipt on an authenticated mesh. A `cotal_anycast` send now names the holders online at send by name and id. Just before a holder's connector shows a role request to its agent, it records its take with the delivery daemon, and the daemon sends the sender a notice naming that holder, with a second notice if the request's ack wait ran out and another holder took it. `cotal_anycast` with `seq` reads the request's status, and with `seq` and `cancel: true` cancels it while it waits; a cancel of a taken request is refused and names the taker. The daemon keeps one CAS-fenced record per request in a new `cotal_anycast_<space>` bucket, serves takes on `cotal.<space>.take.<role>.<owner>.<actor>`, and answers the new `anycastStatus` and `anycastCancel` ops on its control service (SPEC §8.1). Backups exclude the bucket and `cotal restore` recreates it empty.

Two credential shapes change. An agent credential with a role gains its take subject, and the delivery credential gains task-stream reads and deletes, the records bucket and a DM publish as itself. Restart the delivery daemon at this version and respawn every seat that holds a role. Until then a holder on the new connector keeps role requests unshown and reports which of the two it needs. A daemon on an older credential keeps serving durable delivery and records no takes. An open mesh is unchanged and refuses status and cancel. docs/UPGRADING.md has the steps.
