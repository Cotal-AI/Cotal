---
"@cotal-ai/connector-core": patch
---

The agent briefing now offers a single-task helper with `once: true` without listing which harnesses support it.
The manager already refuses a connector that cannot take a once task, so the sentence matches the `cotal_spawn` description, which dropped the same list.
