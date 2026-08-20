---
"@cotal-ai/core": minor
"@cotal-ai/connector-core": patch
"@cotal-ai/pi": minor
"@cotal-ai/manager": minor
---

Managed Pi sessions can now fork an existing Pi transcript into the mesh and recover the exact active Pi session after an unexpected process crash. The Pi adapter reports session changes through its authenticated local control endpoint and an owner-only atomic state file; the manager preserves the Cotal identity, lifecycle UID, credentials, children, and durable inbox across up to three restarts in two minutes, then retires a crash loop loudly. Deliberate stops never restart.
