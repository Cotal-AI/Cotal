---
"@cotal-ai/cli": patch
---

When a space was registered without checking its broker, `cotal whoami` now suggests `cotal space show <name>`. Following the advice keeps the registration and selection even if the broker is offline.
