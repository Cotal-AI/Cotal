---
"@cotal-ai/connector-core": minor
"@cotal-ai/connector-claude-code": minor
"@cotal-ai/web": minor
---

The Claude Code connector publishes a `CUSTOM` event named `cotal.toolResult` on the event plane at each tool result, with the value `{ toolCallId, isError }` and the result's timestamp. It carries no tool input or output: tool arguments and results stay off the channel, and the marker only says which call finished and whether it returned an error. The closed schema admits only that shape, and the vocabulary gate checks it before the frame is written: a marker whose value is malformed, or that carries `rawEvent`, is refused as a vocabulary error rather than frozen in the write-ahead log, where it would halt recovery on every restart. The write path strips `rawEvent` from a marker, and a frozen frame from an older version that still carries one halts. The gate also refuses a marker for a call that is still open. `cotal console` draws the marker as `done` or `failed` under its call, and the dashboard uses it to show whether each call is running, done or failed and how long it took. A connector downgraded across a write-ahead log that holds a marker refuses the event name and halts.
