---
"@cotal-ai/web": patch
---

A detached dashboard start names a pidfile it cannot read and stops, instead of waiting out the readiness window and reporting a timeout with no probe. A missing pidfile still means the child has not claimed it yet.
