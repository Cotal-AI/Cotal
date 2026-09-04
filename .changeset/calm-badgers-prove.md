---
"@cotal-ai/connector-jcode": patch
---

Treat an unreadable or empty Linux process environment as an unprovable launch identity during Jcode bridge teardown, while continuing to refuse readable environments that lack the launch identity.
