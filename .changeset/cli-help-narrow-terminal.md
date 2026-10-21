---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

Help fits a narrow terminal again. A command's usage line breaks only between options, so `[-d | --foreground]` is never split across lines. A flag whose description would have fewer than 30 columns beside it now has its description on the lines under it. Before, the description stayed beside its flag down to about 22 columns, so `cotal help spawn` wrote lines wider than a 60-column terminal. A report's list of commands, such as a `Next` section, follows the same 30-column rule.
