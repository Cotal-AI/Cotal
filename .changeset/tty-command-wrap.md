---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

On a terminal, a command in a report's command list, and a command a sentence names in backticks
after other words, from its `cotal` to its closing backtick, now wrap as one word, so a line copied
from Verdict, Next or a warning is never part of a command. The Next of `space delete` for a prepared space, of
`persona create` over an existing persona and of a `team boot` on a running stack name their
commands in backticks. Before, `reset store <long name>
--dry-run` at 80 columns printed `cotal reset store` on one line and the name on the next.
