---
"@cotal-ai/cli": patch
---

A connector seed that fails now says why on its failure line. With npm missing from PATH, `failed to seed connector "claude" from <path>:` ended in an empty reason, followed by the seed child's progress lines; the reason, here the failed npm install and its `spawn npm ENOENT`, now follows the colon and the progress is printed before it. A seed that fails also stops being reported as an interruption: every later command that seeds said "a previous connector seed was interrupted" after a clean failure. It now says the previous seed failed, gives the reason, and names `cotal ext seed --repair`. A seed stopped by a crash is still reported as interrupted.
