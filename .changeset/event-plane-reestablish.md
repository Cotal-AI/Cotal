---
"@cotal-ai/connector-core": minor
"@cotal-ai/connector-claude-code": minor
"@cotal-ai/connector-opencode": minor
"@cotal-ai/connector-codex": minor
"@cotal-ai/connector-jcode": minor
"@cotal-ai/pi": minor
---

A seat never leaves the mesh because its event plane stopped, and the plane comes back on its own. The emitter holder re-establishes the plane after any failure on a backoff (one second, doubling to a minute, reset once a publish goes through) by a fresh start that replaces the emitter: it reopens the write-ahead log, settles any pending frame, and builds the connector's mapper from the run the log has open before reading on. A turn that ends while the plane is down keeps its terminal, as does one whose terminal's own log write failed, and the re-establish closes that run with it once it has read on; the first terminal kept for a run wins over a repeated one, and when the next prompt was already written before the plane came back the failure is published in place of the finish that prompt would have synthesized, in a frame of the failed run and ahead of the next run's first. The retry delay resets only once a re-establish has gone through in full. The pi adapter's start factory, re-entered by the re-establish, checks the native file instead of reading an acknowledged cursor as a vanished file, and seeds its mapper from the pending frame. A transcript line that is not a record is stepped over and reported on every connector, the jcode journal wrapper included. On a space that requires events the seat used to exit with code 1 instead; for Claude Code that exit was the "MCP server cotal has disconnected" banner, and Claude Code restarted the server on the next tool call. The `eventPlaneStopped` sink no longer takes `required` or `stopSeat`, the holder's `onError` receives the retry delay, the Claude and OpenCode mappers take `resumeRunId`, and a reported unreadable-line reason carries no text from the record itself.
