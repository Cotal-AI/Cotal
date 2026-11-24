---
"@cotal-ai/pi": patch
"cotal-ai": patch
---

Pi launches from `cotal spawn` work alongside an installed standalone Cotal extension. The bundled extension handles the spawned session, and Pi still discovers unrelated extensions.
Foreground and managed spawns require npm-installed Pi on Node 22.19 or newer. Pi's standalone release binary is not supported for spawns.
