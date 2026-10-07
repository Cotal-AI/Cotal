---
"@cotal-ai/connector-core": patch
"@cotal-ai/connector-claude-code": patch
---

Restate the remaining comments in the connector-core event WAL and the Claude Code AG-UI mapper as the rule each one carries, in the present tense. They no longer tell the story of an earlier version, speak in the first person, or name the internal reviewers who found a defect, so none of that reaches the published `dist`. Every rule they held is kept: no `sourceCursor` relation because a cursor is opaque, one check for an absent `pending` key, no seeding in `bindSubjectFrontier`, `expectedTip` throwing while unbound, the stale-writer refusal before the shared record moves, and the `O_EXCL | O_NOFOLLOW` random-name temp file. No behavior changes.
