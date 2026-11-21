---
"@cotal-ai/connector-core": patch
"@cotal-ai/connector-claude-code": patch
---

When a helper starts but its model pin cannot be verified, `cotal_spawn` explains when retrying could start a second agent and how to inspect the helper. If the helper is waiting for the operator, the result names the screen and tells the caller to get the operator to continue before checking the model.
