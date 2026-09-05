---
"@cotal-ai/manager": patch
---

Re-anchor the late-yield mutation `find` on the durable-read code block, not the neighbouring comment.

`smoke:mutation-fixtures` refuses a `find` that spans prose. The #1265 guard used three comment lines to make the window unique; a comment-only tidy would have disarmed it silently. The durable `readGoalResult` block is unique on its own.
