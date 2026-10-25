---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

A command given a `--server` nothing answers at, such as `send` or `history`, now says that nothing
answered at that address, and names the broker recorded for the space when the command runs from
its root or with `--space`. It used to say the space's mesh was recorded there but not running and
to run `cotal up`, which answered that the stack was already running, and in a folder with no space
it named a `main` mesh recorded there that was never recorded. The recorded broker is still never
dialed in its place.
