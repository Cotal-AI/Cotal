---
"cotal-ai": patch
"@cotal-ai/manager": patch
---

Keep Manager status and agent lists available during maintenance and release preservation after its updater exits.

Read-only requests keep their existing membership and owner checks. The daemon uses the updater's authenticated process lifetime to release only its preservation attempt, while live or unknown owners retain their fences.
