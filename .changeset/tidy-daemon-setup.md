---
"cotal-ai": patch
---

Daemon setup rejects invalid space names before installing a service and stops on failed connection prerequisites.

Service-only setup reports the original refusal without a misleading sign-in message or a duplicate registration check. Manager setup still reports unsupported machine services independently of agent launch readiness.
