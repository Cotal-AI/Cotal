---
"@cotal-ai/cli": patch
---

Shell completion now offers a prepared space that has not started. `space delete <TAB>` offers the spaces registered or prepared here, as `space show` and `space forget` do. A channel for `send -c`, `history`, `chat` and `channel show` comes from the space's persona catalog as `spawn` reads it, so a prepared space's declared channels are offered. Both used to offer nothing until the space was started.
