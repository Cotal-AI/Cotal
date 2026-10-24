---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

On a terminal, a command in a report's command list, and a command a sentence names after other
words, in backticks or not, from its `cotal` to its last argument, now wrap as one word, so a line
copied from Verdict, Next or a warning is never part of a command. Before, `reset store <long name>
--dry-run` at 80 columns printed `cotal reset store` on one line and the name on the next.
