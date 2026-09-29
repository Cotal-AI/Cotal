---
"@cotal-ai/lang": patch
---

Forward `observe` through the worker bridge, so a `waitUntil` run hosted by a manager completes instead of failing with "host.options.handler.observe is not a function".
