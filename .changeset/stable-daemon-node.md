---
"@cotal-ai/cli": patch
"cotal-ai": patch
---

Keep daemon services on the invoked Node path so distribution Node upgrades do not strand them on a removed versioned executable. Retain only a same-directory alias of the running runtime, avoiding version managers' transient shell directories. Provide explicit service inspection and replacement guidance for older units without hiding an absent daemon endpoint behind a service lookup failure.
