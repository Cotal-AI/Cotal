---
"@cotal-ai/manager": patch
---

The Manager now keeps its space authentication state (the trust material and whether the space is user-auth) in one object that start fills in, and passes it to the internal parts that read it instead of a callback per value. Exports, commands and wire behaviour are unchanged.
