---
"@cotal-ai/core": minor
"@cotal-ai/delivery": minor
---

`startMembershipFeed` now accepts a source for `observerCreds`, as it already does for `rwCreds`. The feed renews the observer at 75% of its lifetime, proves each candidate on a throwaway connection before the observer connection presents it, and refuses a candidate whose issuer or permission scope differs from the first read. The delivery daemon reads the observer through its secret store, so a host that re-mints it under the same system signer keeps the feed running past the old expiry. A static string keeps today's behavior.
