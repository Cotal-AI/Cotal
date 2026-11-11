---
"@cotal-ai/connector-opencode": patch
---

`cotal models --harness opencode` now lists models on OpenCode 2.x instead of reporting the catalog unavailable. The connector runs `opencode api --standalone GET /api/model`, which starts a private OpenCode server for the one request, and returns each model as a `provider/model` ID with its variant names. A refused request, a reply that is not a model list, or no answer within 10 seconds reports the catalog unavailable with the reason. OpenCode 1.x listing is unchanged.
