---
"@cotal-ai/cli": patch
---

Check a new project's folder-derived space name once inside startup, so an unreadable prepared-space
registry keeps its classified refusal instead of printing a stack trace. Existing prepared or
registered spaces retain their names even when their project records directory is empty or missing.
