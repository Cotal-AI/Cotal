---
"@cotal-ai/cli": patch
---

A usage refusal shows a control character in a word it quotes as its `\uXXXX` escape, as every other report does. An unknown command, subcommand or option, an unknown `config get` key or `docs` page, an invalid channel name, and the excerpt of a `--channels` file that is not JSON used to reach the terminal raw, so a typed or committed escape sequence could clear the screen or retitle the terminal.
