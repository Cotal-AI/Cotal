---
"@cotal-ai/connector-core": minor
"@cotal-ai/connector-claude-code": patch
---

Show a bounded, attributed preview inside Claude Code's existing native Cotal disclosure without consuming the inbox. The collapsed row reports unread count, expansion renders neutralized DM/channel rows, and UI state never drains, acknowledges or commits delivery. Unsupported chat hosts keep the existing tool and wait paths.

`GatewayWake.signal` now receives the rendered preview as a required second argument. Embedders that implement `GatewayWake` with a one-argument `signal` still conform. Code that calls `signal` directly must pass the preview.

Preview rows replace peer control characters and lone surrogates with U+FFFD before they are bounded, so a wake frame always fits the feed and no terminal control reaches the host UI. Line breaks keep their indented continuation.
