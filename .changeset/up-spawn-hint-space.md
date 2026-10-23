---
"@cotal-ai/cli": patch
---

The receipt of a controller `cotal up` now offers `cotal spawn --space <space>`. `up` keeps an existing selection, so after starting a second space the bare `cotal spawn` it used to offer launched into the other, still-selected space.
