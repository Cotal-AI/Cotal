---
"@cotal-ai/cli": patch
---

Show the mesh name on more refusals. A `send` refused for an absent or ambiguous recipient or mention now begins with `Mesh: <space>`, and its JSON envelope carries `target.space`. `history clear` now declares its JSON and plain output, so `history clear --dry-run` on a space that is prepared but not started is a standard `TARGET_UNAVAILABLE` refusal with exit 2 and a JSON envelope, where it printed one line and exited 1. The CLI docs and upgrade notes now show `history clear --yes` and `--dry-run` in place of the removed `--force`.
