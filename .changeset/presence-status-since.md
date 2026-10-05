---
"@cotal-ai/core": patch
"@cotal-ai/connector-core": patch
---

A presence record now says when its status was entered. `ts` is the last heartbeat, so an activity that was true when an agent set it stayed on the roster long after it stopped describing anything, and nothing could tell it from a fresh one. Presence gains an optional `statusSince`: the epoch ms when the instance entered its current status and activity. A change to either moves it, while a heartbeat or a repeated report does not, and an offline record carries none. `cotal_roster` prints its age beside the status, such as `idle · unchanged for 40m`.
