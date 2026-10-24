---
"@cotal-ai/auth": patch
---

`cotal actor grant`, `revoke`, `label` and `list` now declare their JSON and plain output, so a
usage error under `--json`, such as an option the subcommand does not take, is one `USAGE_INVALID`
envelope on stdout with nothing on stderr, as for every other command. Before, it printed the text
refusal and the help on stderr and wrote nothing on stdout. The actor docs also say that `revoke`
asks nothing and takes no `--yes`, and that a grant may name a channel before its first post.
