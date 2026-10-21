---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

Help fits a narrow terminal again. A command's usage line breaks only between options and never between an option and its argument. A usage too wide for the line breaks after its own ` | ` alternatives first. A group of alternatives too wide for the line takes lines of its own and breaks after its own ` | ` the same way, so `cotal help send` keeps `--role/-r <role>` together on a 60-column terminal. Only a single option with its argument that is wider than the line breaks at its spaces. `cotal help --all` wraps its title and group headings to the terminal. Examples are still never wrapped, so each stays one line to copy.

A flag whose description would have fewer than 30 columns beside it now has its description on the lines under it. Before, the description stayed beside its flag down to about 22 columns, so `cotal help spawn` wrote lines wider than a 60-column terminal. A report's list of commands, such as a `Next` section, follows the same 30-column rule.
