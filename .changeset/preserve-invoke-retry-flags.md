---
"@cotal-ai/cli": patch
"@cotal-ai/manager": patch
"@cotal-ai/workspace": patch
"cotal-ai": patch
---

When an endpoint invocation times out before sending the command, the CLI tells you to change only `--timeout` on the original command without displaying its argument values.
