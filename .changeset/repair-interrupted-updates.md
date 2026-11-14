---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
"cotal-ai": patch
---

Updates can continue after an interrupted update leaves an unusable snapshot record.

Keep abandoned records in a timestamped folder without touching their snapshots. Fence live or unreadable owners, wait one hour for records without a valid owner, and report the same recovery guidance in status, notices and unattended updates.
