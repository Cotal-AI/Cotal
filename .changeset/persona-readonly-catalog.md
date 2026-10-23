---
"@cotal-ai/cli": patch
---

`cotal persona create`, `edit` and `remove`, and the legacy `personas new`, `edit` and `rm`, refuse a persona catalog folder you made read-only, such as `.cotal/agents` set to mode 0500, with `PERMISSION_DENIED`, and leave the folder and its files as they were. They used to set the folder back to 0700 and write into it without a word. `edit` refuses before the editor opens.
