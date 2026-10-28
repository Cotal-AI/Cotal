---
"@cotal-ai/cli": patch
---

The console's Ctrl-P palette answers Enter on an action the session cannot take. A row marked `read-only` or `no control path` now hands the line to the command dispatcher, whose refusal on the status line names the missing permission (publishing, or manager control); before, the palette swallowed the key and nothing changed on screen. The action stays blocked: no picker, no spawn form, no send.
