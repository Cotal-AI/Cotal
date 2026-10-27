---
"@cotal-ai/cli": patch
---

The completion command comment no longer says the stub is installed once and never needs reinstalling. `cotal completion install` rewrites a recorded stub when its recorded hash still matches and its bytes differ from this version, and leaves one that already matches. A recorded stub whose bytes no longer match that hash is left unchanged unless `--force` is passed.
