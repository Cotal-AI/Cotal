---
"@cotal-ai/cli": patch
---

`cotal config set <key> <value> --space <name>` now refuses a space that is neither registered nor prepared on this machine with `TARGET_NOT_FOUND`, naming the known spaces, instead of saving a value that no command would ever read. `config unset --space` still takes any name, so a value left for a removed space can be cleared.
