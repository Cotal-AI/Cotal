---
"@cotal-ai/connector-core": patch
---

Restate the subject-frontier comments, which ship in `dist/subject-frontier.js` and `dist/subject-frontier.d.ts`, as the rules they carry in the present tense. They no longer narrate the failure measured before the module existed, a first attempt at recovery, an earlier description of the scan, the removed `seedFromThread`, or the code that preceded the directory fsync helper. Every rule is kept: the subject tip belongs to the principal and every thread advances it, recovery scans every sibling thread log only when the record is absent and never when it reads zero, an unreadable sibling is fatal, `advance` re-reads the record before writing, and a `sent_unacked` pending contributes no sequence. No behavior changes.
