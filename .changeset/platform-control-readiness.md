---
"@cotal-ai/auth": minor
---

A platform composition can now ask whether its assigned control manager is serving. With the `platformControl` input, `startAuthService` returns a handle with `platformControlReadiness(instanceId)`, which answers that manager instance's `status` reply and refuses any instance the current assignment does not name, or one whose gate another owner holds. The auth context reads over its own connection, whose grant is that instance's `describe` and `status` and its own reply rail. The connection renews in process like the context's other connections and never leaves it, so a pooled control host no longer needs a human or operator credential, a per-read control instrument, or the manager's process id to tell whether the manager is up.
