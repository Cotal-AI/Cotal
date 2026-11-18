---
"@cotal-ai/cli": patch
"cotal-ai": patch
---

Keep daemon services on the invoked Node path so distribution Node upgrades do not strand them on a removed versioned executable. Verify that the path resolves to the running runtime before retaining it, and provide explicit service inspection and replacement guidance for older units.
