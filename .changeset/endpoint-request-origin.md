---
"@cotal-ai/core": patch
---

Discard native stored-message provenance at ephemeral endpoint ingress before parsing, authorization, dispatch or replies. Direct requests retain their existing headers and admission checks; read grants are unchanged.
