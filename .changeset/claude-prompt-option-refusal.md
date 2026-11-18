---
"@cotal-ai/connector-claude-code": patch
---

A Claude spawn now always delivers its initial prompt as the first turn, whatever the prompt's text. The connector passes the prompt to `claude` after one leading space, so a prompt that names a `claude` command or starts with `-` is no longer read as that command or as an option. A resume session id that starts with `-` is refused with a message naming the rule.
