---
"@cotal-ai/cli": patch
---

An open start now writes its space into `.cotal/server-open.conf`, so a bare `cotal up` after `down` on an open legacy root started with `--open --space` starts that space again. It used to start and select a space named `main` in the same store. After a later plain open start of another space at a root deployed with `up -f`, a bare `cotal up` starts the space that ran last, not the manifest's.
