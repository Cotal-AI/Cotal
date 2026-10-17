---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
"@cotal-ai/web": patch
---

`cotal status --components` now names the HTTP status when the web dashboard's address answers `/api/meta` with a status outside 2xx, such as `HTTP 401`. It used to read the body first, so a plain-text or empty refusal printed `http not answered`. The status row and `cotal web --detach` now send one shared readiness request from `@cotal-ai/workspace` and read its answer the same way.
