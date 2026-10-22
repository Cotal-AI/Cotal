---
"@cotal-ai/connector-core": minor
"@cotal-ai/connector-claude-code": minor
"@cotal-ai/web": minor
---

The Claude Code connector publishes a `CUSTOM` event named `cotal.toolResult` on the event plane at each tool result, with the value `{ toolCallId, isError }` and the result's timestamp. It carries no tool input or output: tool arguments and results stay off the channel, and the marker only says which call finished and whether it returned an error. The closed schema admits only that shape, so a marker carrying any other field halts the publish, and the vocabulary gate refuses a marker for a call that is still open. `cotal console` draws the marker as `done` or `failed` under its call, and the dashboard draws it the same way and adds no session step for it. A connector downgraded across a write-ahead log that holds a marker refuses the event name and halts.
