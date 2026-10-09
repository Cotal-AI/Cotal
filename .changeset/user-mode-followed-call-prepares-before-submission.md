---
"@cotal-ai/connector-core": patch
---

A followed manager call from a user-mode seat, such as `cotal_spawn`, now runs its bearer command, opens its control connection and resolves the manager as preparation before the submission starts. A failure in any of those steps used to be reported as a submission whose outcome was unknown and that "may have been accepted or executed", although nothing had been published, and the error's details were dropped. It now surfaces as its own error, and a stop or the call's deadline during those steps reports that the request was not run. Only the command publish runs as the submission.
