---
"@cotal-ai/runtime": patch
"@cotal-ai/connector-core": patch
---

A workflow deadline short enough to pass while its pause was being armed failed the step L4000, "pause … was due … and nothing was minted for it", instead of ending it as that deadline's expiry does. A `wait` with a `1ms` timeout now resolves `null`, an `idle` window of `1ms` returns its event, a `waitUntil` with a `1ms` cadence observes again until its deadline fails it with L4023, and a `1ms` or `2ms` checkpoint expires for its `onExpiry` to act on. A `wait` still opens its channel under the run's read admission first, so a channel the run may not read is refused as before. `sleep` and `ask` already ended this way.
