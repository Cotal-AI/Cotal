---
"@cotal-ai/connector-codex": patch
---

`cotal models --agent codex` now reports a Codex catalog error when the `codex app-server` child closes its input before `model/list` is answered. The write to the closed pipe used to fail with an unhandled `EPIPE` that crashed the manager, so the call timed out and every later request found no manager until it was restarted.
