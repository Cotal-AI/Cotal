---
"@cotal-ai/auth": minor
---

`cotal auth-service --callout-only --spaces <manifest>` now starts with the spaces it can serve instead of refusing unless every space opens. It names each space it cannot serve with the reason, retries those every 5 seconds, and its ready line counts the spaces answering against the spaces named and lists the ones it retries. A space whose service endpoint admission is open, which the first start of its full auth service with service endpoints opens and nothing closes, no longer keeps every other space in the manifest unanswered by the host or crash-loops it under a supervisor. Such a space still gets no lane, so the host never answers its connects. A refused space's retry opens one store connection to read its admission, before the lane's reader connection, and holds nothing between retries. `auth-service --callout-only --space <s>` is unchanged.

`@cotal-ai/auth` exports `admitsServiceEndpoints({ space, server, secrets })`, which resolves `true` for the spaces a callout lane refuses for their admission, with the lane's own read on the lane's own store grant, so a manifest writer keeps those spaces off callout host manifests.

**Breaking:** a supervisor or script that relied on `auth-service --callout-only --spaces` exiting nonzero when one space could not open now sees the host start; read its ready line or its per-space lines for the spaces it retries. See UPGRADING.
