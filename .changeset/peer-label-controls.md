---
"@cotal-ai/core": patch
---

`peerLabel` now prints every control character and Unicode line or paragraph separator in a peer's name or role as a space, as it already did for line breaks and brackets. Before, a peer that put ESC, BEL, a C1 control or a tab in its name, or in the role of the presence record it writes itself, had those bytes printed raw on every surface that labels it, including `cotal endpoints`, `cotal status`, `cotal join` and the console.
