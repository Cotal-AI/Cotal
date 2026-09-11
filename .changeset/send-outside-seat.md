---
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
"cotal-ai": patch
---

Allow `cotal send dm`, `msg`, and `ask` from an operator shell outside a managed seat. The transient
sender now uses a fixed advisory display name while its wire principal continues to come from the
resolved credential or user bearer.
