---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

`auth mint --identity` keeps the read channels, post channels and role of the agent credential it names, unless a flag replaces one, and the mint receipt and JSON list the grants. `auth mint --out` records the file it wrote, without the credential, and `doctor auth` lists each such file with its state and expiry, naming the mint that renews it or, for a revoked key, a mint with a new key.
