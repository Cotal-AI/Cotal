---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

A checked user-auth bundle's type now carries the pinned exchange URL that `checkUserBundle` requires, so callers read `userAuth.endpoints.url` without non-null assertions.
