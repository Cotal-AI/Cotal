---
"@cotal-ai/auth": patch
---

Retire an interactive actor lifecycle through the local auth authority plane before `cotal actor grant` rotates it or `actor revoke` removes it, so copied bearers are invalidated and later grants can create a real successor.
