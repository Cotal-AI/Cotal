---
"@cotal-ai/cli": patch
"cotal-ai": patch
---

`cotal service` now points a stopped controller stack member at bare `cotal up`, and refuses to start or restart one by itself.

Starting `stack-broker`, `stack-delivery` or `stack-manager` on its own, or the preset name that reaches it, launches the process and leaves the space unregistered, so later commands fail until `cotal down`. The start now stops before anything launches and tells you to run `cotal up`. The guard checks the saved adapter and controller journal, so a direct-process service with the same name still starts and restarts normally.
