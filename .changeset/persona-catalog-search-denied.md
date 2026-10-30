---
"@cotal-ai/cli": patch
---

Refuse a persona catalog folder that lists its file names but cannot be searched, such as one set to
mode 0600. `persona` used to report each valid persona there as `SCHEMA_INVALID` (exit 4), the legacy
`personas list` marked each one unparseable (exit 0), and name completion offered personas that
could not be opened. Both commands now refuse it with `PERMISSION_DENIED` (exit 2) and the same next
step as an unreadable catalog, whether the folder is empty or not, and completion fails and names the
catalog. A malformed persona file in a readable catalog is still reported as before.
