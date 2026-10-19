---
"@cotal-ai/core": patch
"@cotal-ai/cli": patch
"@cotal-ai/manager": patch
---

`@cotal-ai/core` now exports `rejectionText`, which turns a caught value into the text of a refusal or a log line, and the cleanup recorder `attemptCleanup`, `describeCleanupFailures` and `CleanupFailure`. The CLI's and the manager's spawn rollbacks each kept their own copy of both, and the copies had already drifted: the CLI recorded each failed step with the value it threw, while the manager recorded a finished string. Both now use the core helpers and record the step with the value it threw. Refusal and log text are unchanged.
