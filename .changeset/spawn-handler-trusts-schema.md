---
"@cotal-ai/manager": patch
---

The manager's `spawn` handler no longer repeats the shape checks on `launchOptions`, `supervise`, `subscribe`, `allowSubscribe`, `allowPublish` and `shareTools`. The served command validates the request against its input schema first and refuses those shapes with `bad-request`, so the handler's copies never answered. Refusals are unchanged.
