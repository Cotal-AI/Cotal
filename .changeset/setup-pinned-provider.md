---
"cotal-ai": patch
---

Daemon setup rejects a different sign-in provider before asking for device approval.
For a locally registered space that needs sign-in, both setup modes check the supplied provider
against the space's pinned provider and name the corrected setup command on refusal.
