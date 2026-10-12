---
"@cotal-ai/connector-core": minor
"@cotal-ai/connector-claude-code": minor
"@cotal-ai/connector-opencode": minor
"@cotal-ai/connector-codex": minor
"@cotal-ai/connector-jcode": minor
"@cotal-ai/pi": minor
---

A seat never leaves the mesh because its event plane stopped. The emitter holder re-establishes the plane itself on a backoff (one second, doubling to a minute) after any failure, reopening the write-ahead log and settling any pending frame before it reads on, and the connector log says when. On a space that requires events the seat used to exit with code 1 instead; for Claude Code that exit was the "MCP server cotal has disconnected" banner, and Claude Code restarted the server on the next tool call. The `eventPlaneStopped` sink no longer takes `required` or `stopSeat`, the holder's `onError` receives the retry delay, and a reported unreadable-line reason carries no text from the record itself.
