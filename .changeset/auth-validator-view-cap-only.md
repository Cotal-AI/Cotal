---
"@cotal-ai/auth": minor
---

`validateUserToken` no longer takes `maxTtlSec`. It caps a bearer's lifetime at the cap of the bearer's view, the same cap the issuer applies at mint: 900 seconds, or 300 for a `transfer-writer` bearer. Nothing in the repository passed the option, and a `NaN` value, such as `Number()` of an unset environment variable, turned the lifetime check off so a bearer of any lifetime was accepted. A caller that needs a shorter-lived bearer mints one.
