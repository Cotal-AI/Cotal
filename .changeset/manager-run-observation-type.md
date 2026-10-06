---
"@cotal-ai/core": patch
"@cotal-ai/auth": patch
---

`authorizeRemoteManagerRenewal` now takes its run observation as the exported `ObserveManagerRun`, built on core's new `HostedRunAttempt`, instead of an inline shape whose `state` was a plain `string`. `observeHostedRunAttempt` returns `HostedRunAttempt`, so its `state` is a `RunState`. A misspelled or unknown run state in an observation, or in a comparison against one, now fails the typecheck where it used to compile. Renewal accepts and refuses the same runs as before.
