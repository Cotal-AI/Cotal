---
"@cotal-ai/auth": patch
---

Hosted auth planes can persist callout account claim transitions and renew callout credentials without changing account or user identities. The auth store now validates claim authority continuity and atomically stores same-key callout and sentinel generations.
