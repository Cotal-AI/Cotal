---
"@cotal-ai/cli": patch
---

`cotal up --foreground` now wraps its `Starting nats-server` line and its `✗ nats-server exited unexpectedly` line at spaces on a terminal, as other lines and failures do. Each continuation starts under the text it continues, a path keeps a line of its own, and a command in backticks such as the `repair:` command stays on one line. Off a terminal each is still one line, the start line on stdout and the exit line on stderr. Under a locale that is not UTF-8 the exit line begins with `!`, as other failure lines do.
