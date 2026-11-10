---
"cotal-ai": patch
---

Linux daemon installation now refuses an existing unrecorded unit path before changing linger or starting a service. Dry runs report the same conflict, and an uninspectable path refuses instead of being treated as absent.
