---
"@cotal-ai/core": patch
"@cotal-ai/runtime": patch
"@cotal-ai/manager": patch
"@cotal-ai/connector-core": patch
---

`cotal run show` and `cotal run journal` now say why a step failed. A failed or refused step's journal row carries its recorded `errorMessage` beside `errorCode` in `--json`, and the text view lists each such step with its outcome and message under `Step errors`, escaping control characters. Before, both views printed only `failed (L4000)`, and the reason, such as a hosted run that is not admitted to read a channel, was only in the manager's log. The manager's `run-status` reply schema admits the new field.
