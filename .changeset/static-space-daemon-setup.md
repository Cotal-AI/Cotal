---
"cotal-ai": patch
---

Refuse machine-service setup for local static-auth spaces before recording a hosted Manager refusal.
Setup, registration, service status and disconnect direct these spaces to their local `cotal up` stack instead of commands that cannot host them. Guidance reads only the requested space's record, so an unrelated unusable record does not interrupt daemon status. A damaged requested record refuses service status without stopping the daemon.
