---
"@cotal-ai/cli": patch
---

`cotal update` verifies each installed built-in connector and the web dashboard against the payload the binary ships, byte for byte, and reinstalls only the ones that differ, instead of reinstalling all seven on every run. `cotal ext seed --force` still reinstalls unconditionally.
