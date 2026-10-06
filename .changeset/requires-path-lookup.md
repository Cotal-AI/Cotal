---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

`cotal status` and `cotal setup` now decide whether a connector's `requires` executables are present with the same PATH resolver as the manager and manifest preflights. A `requires` entry written as a path is checked as given instead of being joined under every PATH directory, so an absolute path or `./tool` is no longer reported as missing and `bin/tool` under a PATH directory is no longer reported as ready. The shared resolver now skips a directory that matches on PATH, as exec does, so a directory named like a harness no longer counts as that harness or hides the real binary later on PATH.
