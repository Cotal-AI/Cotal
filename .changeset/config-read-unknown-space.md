---
"@cotal-ai/cli": patch
---

`cotal config --space <name>`, `config get <key> --space <name>` and `config unset <key> --space <name>` now refuse a space that is not registered, not prepared and holds no saved value with `TARGET_NOT_FOUND` (exit 2), naming the known spaces, as the docs say. Before, they exited 0 for any name. A space that still holds a saved value can still be read and unset, so a value left for a removed space can be cleared.
