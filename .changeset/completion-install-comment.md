---
"@cotal-ai/cli": patch
---

The completion command comment no longer says the stub is installed once and never needs reinstalling. `cotal completion install` refreshes a recorded stub whose bytes differ from this version, and leaves one that already matches.
