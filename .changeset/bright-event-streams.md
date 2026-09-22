---
"@cotal-ai/core": minor
"@cotal-ai/workspace": minor
"@cotal-ai/cli": minor
"@cotal-ai/manager": minor
"@cotal-ai/connector-core": minor
"@cotal-ai/connector-claude-code": minor
"@cotal-ai/connector-opencode": minor
"@cotal-ai/connector-codex": minor
"@cotal-ai/connector-jcode": minor
---

Enable the AG-UI event plane by default for connectors that publish one. Operators and peer spawns
can opt out explicitly, while connectors without an event plane refuse unless that opt-out is set.
