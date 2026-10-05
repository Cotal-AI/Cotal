---
"@cotal-ai/cli": patch
---

A mesh registry record this build cannot use no longer refuses a command in the catalog refresh that runs before the command's own checks. While such a record is planted the refresh is skipped, so `cotal spawn` reports its own usage errors and a managed handoff refuses with its handoff-phase sentence instead of the record's path. Every command that resolves its target through the registry still refuses the record by name.
