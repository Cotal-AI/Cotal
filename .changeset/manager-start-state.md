---
"@cotal-ai/manager": patch
---

The Manager's start-time state object now also holds its instance id, and is renamed for what it holds: what start learns about the manager. The internal parts read the instance id from it instead of through a callback each. Exports, commands and wire behaviour are unchanged.
