---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

A command run in a folder whose stack was stopped with `cotal down` no longer dials the default broker address `127.0.0.1:4222`. That `down` drops the folder's registration, and commands such as `send`, `history`, `ps` and `who` then fell back to the default address and presented the folder's credentials to whatever listened there. They now refuse with `TARGET_UNAVAILABLE`, naming the address the folder's last start configured, with the bare `cotal up` that starts it there again as the Next.
