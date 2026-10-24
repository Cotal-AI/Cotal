---
"@cotal-ai/cli": patch
---

`cotal service add <name> --preset broker` used the preset's own `--server` and `--root` to choose the space. In a prepared space that was not started it saved the definition into "main", even with that space selected, and with `--space` it refused as "prepared but not started". Only `--space`, the selected space or the folder's space now choose where it is saved, as for `--file`.
