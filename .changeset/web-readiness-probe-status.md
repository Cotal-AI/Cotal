---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
"@cotal-ai/web": patch
---

`cotal status --components` now names the HTTP status when the web dashboard's address answers `/api/meta` with a status outside 2xx, such as `HTTP 401`. It used to read the body first, so a plain-text or empty refusal printed `http not answered`. The status row and `cotal web --detach` now send one shared readiness request from `@cotal-ai/workspace` and read its answer the same way. That request no longer follows a redirect, so the readiness header goes only to the recorded address and a 3xx answer is reported as its status, such as `HTTP 302`, where both used to follow it and accept the identity the redirect target answered with.
