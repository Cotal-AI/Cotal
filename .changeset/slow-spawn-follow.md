---
"@cotal-ai/core": patch
"@cotal-ai/manager": patch
"@cotal-ai/connector-core": patch
---

Keep synchronous spawn callers waiting through the connector-selected readiness budget instead of timing out early on slow healthy launches.
