---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

Renaming a project folder while its stack ran stranded it. The running broker created empty store folders at the old path within seconds, so `up` and `down` in the renamed folder said it was a copy and to use the stack from the old path, and `send`, `history` and `service stop` said the seed under the old path was missing. The broker configuration now names a store inside the project folder relative to it, and the broker runs from that folder, so a renamed folder keeps the broker's writes and the old path is not created again. `up`, `down`, `send`, `history`, `ps`, `service status` and `service stop` in a moved folder now refuse `CONFLICT`, say it was moved, and say to move it back, moving aside anything found at the old path first.
