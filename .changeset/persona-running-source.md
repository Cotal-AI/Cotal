---
"@cotal-ai/core": patch
"@cotal-ai/workspace": patch
"@cotal-ai/connector-core": patch
"@cotal-ai/cli": patch
"@cotal-ai/manager": patch
---

`cotal personas list --running` recognizes live sessions launched from a catalog entry even when their display names differ. Saved inline, manifest, and delegated launches retain their catalog source. Reusing a removed persona name does not inherit the old session's running status.
