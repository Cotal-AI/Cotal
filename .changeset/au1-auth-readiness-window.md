---
"@cotal-ai/auth": patch
"@cotal-ai/cli": patch
---

Bind the user-auth service readiness wait to the daemon process, not a clock alone. A same-root `cotal up` refresh run right after a broker reload killed the old auth-service daemon used to give up at a fixed 15s while the replacement daemon it launched was still binding, then a second identical `up` succeeded: a one-shot false "auth service not ready". `ensureAuthService` now passes the pid it launched (or found live) into the provider's `ready()`, which waits past the base timeout up to 60s while that pid is provably alive, ends the wait at once when the pid exits ("exited before becoming ready"), and refuses at the bound naming the live pid, the pid record, and the service log ("alive and still starting"). `AuthServiceSpec.ready` gains optional `pid`/`maxWaitMs` inputs; callers that pass none keep the old clock-only behavior.
