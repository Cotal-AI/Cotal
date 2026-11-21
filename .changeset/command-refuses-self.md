---
"@cotal-ai/connector-core": patch
---

An agent can no longer run one of its own commands through its `agent` endpoint. `command` from the agent's own identity is now `permission-denied`, `not-executed`, before any other check, as `prompt-answer` already refuses an agent answering its own prompt.
