---
"@cotal-ai/seat": patch
---

The seat package now reads `/proc/<pid>/stat` through one parser. Before, five readers each repeated the comm-terminator rule and their own field offset, and three of them skipped the terminator check. On a line with no `) ` those three read a field from inside the pid, so a process's parent could come back as an unrelated pid and the run marker walk could adopt that process's `COTAL_RUN`, while the launcher and custodian called a process live that the start-token readers called gone. Every reader now treats such a line the way it treats a pid with no `/proc` entry.
