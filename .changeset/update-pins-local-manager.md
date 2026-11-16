---
"@cotal-ai/cli": patch
---

Pin local Managers during software updates on every platform.

The updater reads native process and Manager identity records before requesting a user-auth control caller, so another machine's Manager does not make local update selection ambiguous.
