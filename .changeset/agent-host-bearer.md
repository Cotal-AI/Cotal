---
"@cotal-ai/connector-core": minor
---

`AgentConfig.userAuth` accepts `bearer`, a function returning a fresh bearer, in place of `bearerCmd`. A service that runs agents in its own process can now renew each agent's user-mode credential without executing a command per refresh. Such an agent has no manager-call bearer, so its spawn, despawn, persona and run calls are refused with a message that says so. Launched seats keep using `bearerCmd` unchanged.
