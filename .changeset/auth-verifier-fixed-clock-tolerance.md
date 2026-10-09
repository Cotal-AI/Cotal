---
"@cotal-ai/auth": minor
---

`validateUserToken` and the `IdpConfig` of `verifyIdpToken` and `createIdpBridge` no longer take `clockToleranceSec`. Both verifiers allow a fixed 5 seconds of clock skew, the default they already applied. Nothing in the repository passed the option, and a `NaN` value, such as `Number()` of an unset environment variable, turned off the expiry, not-before and issued-at checks so an expired or post-dated token was accepted, while a large value widened them by that many seconds.
