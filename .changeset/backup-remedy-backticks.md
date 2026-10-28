---
"@cotal-ai/cli": patch
---

Name the retry command in backticks when `backup create` meets another operation's maintenance lock, and the `backup cleanup-fallback` command when `up -f` refuses over an active restore, so the wrapper keeps each command whole.
