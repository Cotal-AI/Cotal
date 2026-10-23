---
"@cotal-ai/cli": patch
---

`cotal help personas <subcommand>` and `cotal personas <subcommand> --help` print that subcommand's usage for `list`, `show`, `edit`, `new` and `rm`. `help personas new` and `help personas list` said the subcommand did not exist, although `personas` runs them.
