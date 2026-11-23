---
"@cotal-ai/manager": patch
---

The Manager now keeps its hosting authority in its read-only config, and its internal parts read it from there instead of through a callback each. Exports, commands and wire behaviour are unchanged.
