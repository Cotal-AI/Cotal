---
"@cotal-ai/connector-core": minor
"@cotal-ai/connector-claude-code": patch
---

Show a bounded, attributed preview inside Claude Code's existing native Cotal disclosure without consuming the inbox. The collapsed row reports unread count, expansion renders neutralized DM/channel rows, and UI state never drains, acknowledges or commits delivery. Unsupported chat hosts keep the existing tool and wait paths.

`GatewayWake.signal` now receives the rendered preview as a required second argument. Embedders that implement `GatewayWake` with a one-argument `signal` still conform. Code that calls `signal` directly must pass the preview.
