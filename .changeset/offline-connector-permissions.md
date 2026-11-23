---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

When self-update repairs connector directory permissions but cannot reach the registry, it reports that no installed packages were replaced.
It gives the same report if it recovers an interrupted extension promotion before the registry check.
