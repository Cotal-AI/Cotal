---
"@cotal-ai/cli": patch
---

A controller stack keeps the `--max-sessions` an earlier `cotal up` set. A bare `up` after `cotal down` used to start the manager with the default of 64, because the manager's definition was rebuilt from the command line alone. It now takes the ceiling from the saved definition, and an explicit `--max-sessions` still replaces it.
