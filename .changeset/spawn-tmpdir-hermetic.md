---
"@cotal-ai/auth": patch
"@cotal-ai/cli": patch
"cotal-ai": patch
---

Sandbox the temp root in the smokes that mint a mesh fixture there, so a `.cotal` left above the temp base (`/tmp/.cotal` on Linux CI runners) can no longer capture the fixture and make a suite grade a live mesh. One shared implementation in `bin/smoke/_scratch.ts`, used by `spawn-from-anywhere`, `down-target`, and both `ps` suites. The dead-manager cells now assert that the manager was found, was alive, and is dead, instead of skipping their own kill when the pid file is missing.
