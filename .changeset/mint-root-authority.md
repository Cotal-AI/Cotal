---
"@cotal-ai/cli": minor
---

Keep agent-profile minting within one resolved mesh root.

`cotal mint` now reads the persona ACL, loads the signing authority, and stores the default credential under the selected mesh root. If the current folder holds trust for a different space or account, it refuses before writing and names both roots instead of combining authority material from one root with persona policy from another.
