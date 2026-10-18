---
"@cotal-ai/connector-core": minor
---

Add a private tool-result journal and the `tool-result` command. A connector can keep the tool results its harness reported, never the arguments, in a bounded in-process journal keyed by the native thread and tool-call ids, and serve them only to a redeemed `handle`-mode capability on that exact agent and lifecycle. Sharing defaults to `off`. Answers distinguish `available` (falsey results included), `pending`, `not-shared`, `missing` and `expired`. The event-plane egress fence is unchanged, so results still never ride a channel.
