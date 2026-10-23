---
"@cotal-ai/cli": patch
---

`auth mint --endpoint`, `ep describe` and `ep invoke` now say when no instance of the endpoint
answered its contract read: they refuse with `TARGET_UNAVAILABLE`, exit 2, and their Next says to
start the service that serves it. They used to fail with "the endpoint contract read did not
complete", exit 5, and no Next.
