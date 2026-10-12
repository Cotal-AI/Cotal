---
"@cotal-ai/connector-core": minor
"@cotal-ai/connector-claude-code": minor
---

A transcript line the harness left unreadable no longer ends the event plane for good. A write cut short by a full disk leaves part of one record glued to the next on a single line; the reader threw on that line and its cursor never passed it, so every restart died at the same byte, and on a space that requires events the Claude Code connector exited with it, which the harness showed as a disconnect. `JsonlFileSource` now steps over such a line and reports it on the read as a `SourceGap` with its offset, length and the parser's reason; `AguiEmitter.start` takes an `onUnreadable` reporter and refuses to advance over a gap when none was given. The Claude Code connector reports each gap on its stderr and keeps the records after it.
