---
"@cotal-ai/cli": patch
---

A mesh registry record this build cannot use no longer refuses a command in the catalog preparation that runs before the command's own checks. While such a record is present the preparation neither refreshes nor applies a catalog, so `cotal spawn` reports its own usage errors and a managed handoff refuses with its handoff-phase sentence instead of the record's path. A snapshot an interrupted command left unapplied is applied once the record is restored or removed. Every command that resolves its target through the registry still refuses the record by name.
