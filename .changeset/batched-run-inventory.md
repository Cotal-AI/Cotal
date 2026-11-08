---
"@cotal-ai/core": patch
"@cotal-ai/runtime": patch
"@cotal-ai/auth": patch
---

Batch workflow inventory record reads so a few hundred completed runs do not require separate reads for every record. Preserve dotted endpoint names, program validation, deleted-record handling and unreadable revocation reporting. Only list credentials gain the records Direct Get permission; single-run reads and checkpoint answers keep their existing permissions.
