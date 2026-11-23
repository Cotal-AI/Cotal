---
"@cotal-ai/cli": patch
---

When a startup IdP conflicts with the pinned IdP, retry with the same user-auth options and omit the conflicting `--idp`.
