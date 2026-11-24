---
"@cotal-ai/cli": patch
---

When a stopped stack has no record of its broker address, ask the operator to add the address to their original startup command so a broker-only retry does not start a Manager.
