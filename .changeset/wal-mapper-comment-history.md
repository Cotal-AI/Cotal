---
"@cotal-ai/connector-core": patch
"@cotal-ai/connector-claude-code": patch
---

Remove comment passages from the connector-core event WAL and the Claude Code AG-UI mapper that narrated earlier revisions of those comments, who flagged them, and the session they were written in. The `bindSubjectFrontier` doc ends at its contract, the temp-file write keeps its `O_EXCL`, `O_NOFOLLOW`, random suffix and `0600` rationale, and the mapper header states its measurement directly: 67 runs and 5217 events on the 5938-record session, with `diagnose()` returning `null`. No behavior changes.
