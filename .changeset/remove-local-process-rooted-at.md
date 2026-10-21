---
"@cotal-ai/workspace": minor
"@cotal-ai/web": minor
---

The `rootedAt` field is gone from the local-process extension contract. Nothing has read it since the
dashboard became a service, and the web extension no longer sets it. An extension that still declares
it has the field dropped from its cached descriptor, like any other unknown field.
