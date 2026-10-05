---
"@cotal-ai/connector-core": patch
"@cotal-ai/connector-claude-code": patch
"@cotal-ai/connector-opencode": patch
---

Remove sentences from the AG-UI holder and the Claude Code and OpenCode AG-UI mapper comments that described what earlier revisions of those comments got wrong. The comments now state only the current contract: the `boundPath` gate keeps start-once, the chain serializes hook events, the refusals live in `subject-frontier.ts` and `event-wal.ts`, the bracket interleave is open, OpenCode publishes `RUN_ERROR` through `AguiEmitterHolder.closeRun`, and the Claude Code mapper keeps its measured predicate counts. No behavior changes.
