---
"@cotal-ai/connector-core": patch
"@cotal-ai/connector-claude-code": patch
---

Keep Claude lifecycle hooks inside their existing bounded relay window when the connector control socket has not bound yet, and wait boundedly for a new startup transcript that the retained `SessionStart` can precede.
