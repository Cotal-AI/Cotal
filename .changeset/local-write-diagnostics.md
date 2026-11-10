---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
"cotal-ai": patch
---

Local write failures now name the file, explain the storage limit and give a next step.
Space preparation, preferences and local persona saves report storage failures separately from
invalid input and unknown outcomes. A failed default-persona seed reports the prepared record
that was already saved and warns that the persona file may be incomplete. Initial project
directory creation failures carry the same storage diagnosis and retry guidance.
