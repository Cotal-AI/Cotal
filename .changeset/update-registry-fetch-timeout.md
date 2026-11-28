---
"@cotal-ai/cli": patch
---

`cotal update --self` treats an npm registry that accepts the connection and never answers as unreachable, so nothing is replaced and the command exits 0.
