---
"@cotal-ai/lang": minor
"@cotal-ai/core": minor
"@cotal-ai/runtime": minor
"@cotal-ai/manager": minor
"@cotal-ai/delivery": minor
"@cotal-ai/connector-core": minor
"@cotal-ai/connector-claude-code": minor
"@cotal-ai/connector-codex": minor
"@cotal-ai/connector-jcode": minor
"@cotal-ai/connector-opencode": minor
"@cotal-ai/pi": minor
"cotal-ai": minor
---

Every cotal-lang effect now performs on the mesh: the durable-action group is built end to end and
the not-yet-durable seam is gone.

`spawn` submits a real manager goal and returns the allocated seat's handle; `conclave` opens a
scoped sub-team as durable membership rows; `ask` parks schema-checked pauses answered through
`cotal run answer`; `monitor` and `wait(down)` read an incarnation's death off presence liveness.
`turn` rides a new pull-shaped manager relay: the manager serves `turn` (targeted, the
despawn/input reach) plus `turn-pending` and `turn-yield` (self reach, manager contract revision
10), holds the payload on the goal-index note, pins the goal to the seat's incarnation, and denies
at a goal-bound deadline hold; the seat side (all connectors) pulls pending turns, surfaces them
two-phase into host context, auto-yields `done` when the host turn ends, and yields `blocked` or
`handoff` through the new `cotal_yield` tool; the run client renders context with pending notices,
arms its own pause as the L4003 authority, watches presence as the L4002 authority, and honors
handoffs (L4005/L4004 validation, the `handoffFrom` goal chain, the run record's new
`conversationOwner` field). `wait(replied)` observes the run's own turn terminals as a level. A
`spawn` may bind a logical worktree: the validator rejects two literal-worktree spawns in one
concurrent scope (L3022) and the runtime refuses a spawn into a live holder's tree (L4008), with
sequential reuse the moment the holder's presence lapses. The run driver re-issues
recorded-but-undischarged cancellations at adoption, so recovery does not wait for completion to
release a dead loser's seat, pause, or tree. The delivery daemon hosts the checkpoint timer
writer, so mediated deadlines fire with no suite pump.
