---
"@cotal-ai/auth": patch
---

Strip ambient `COTAL_` variables from the environment the connect-load harness hands its child processes. Whatever runs the harness may itself be a managed agent session whose `COTAL_SERVERS` and credential variables name a live mesh, and a bare `process.env` spread handed those to every load and callout-service child instead of leaving them on the private broker the harness builds.
