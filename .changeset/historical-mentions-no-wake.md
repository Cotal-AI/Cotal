---
"@cotal-ai/connector-core": patch
"cotal-ai": patch
---

Keep all replayed channel messages, including mentions, pull-only so joining a channel cannot revive old requests as new agent turns. Frame historical content separately without the action-oriented footer, while preserving wakes for new mentions and direct messages.
