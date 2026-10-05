---
"@cotal-ai/connector-opencode": patch
---

An OpenCode 1.x seat that has begun a cooperative stop now refuses a prompt typed into its TUI or posted to its server API. The refusal comes before OpenCode saves the prompt, so no model turn starts after the seat has announced it is leaving. OpenCode reports the reason, `the prompt was not run: this seat is shutting down`, as a `session.error` event for an asynchronous prompt and only in its server log for a synchronous one, which answers with a generic server error. Before, the stop fence returned early from `chat.message`, which OpenCode does not treat as a refusal, and the prompt ran a full turn while the seat was tearing down. A turn that was already running when the stop began is not cancelled.
