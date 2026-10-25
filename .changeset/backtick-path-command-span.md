---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

On a terminal, a command whose quoted path holds a backtick now wraps as one word. The `team boot`
refusal on a running stack and the `status` hint after `space forget` name such a command between
double backticks, as Markdown writes code that holds a backtick, and the wrap keeps it whole to the
matching pair. Before, at 80 columns in a folder named ``tick`q "dq" $(x)``, the path's own backtick
ended the command and the line broke inside the quoted path. The command between the backticks is
unchanged.
