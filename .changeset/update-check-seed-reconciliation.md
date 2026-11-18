---
"@cotal-ai/cli": patch
---

Update checks now report unfinished connector seeding and name the repair command. Read the persisted seed cursor and recovery journal without changing them, report pending or unreadable seed state as partial with exit code 4, and retain update-recovery receipt precedence.
