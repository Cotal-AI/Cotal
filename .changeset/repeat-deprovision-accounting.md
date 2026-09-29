---
"@cotal-ai/core": patch
"@cotal-ai/manager": patch
"@cotal-ai/auth": patch
---

Deprovisioning returns truthful bounded resource accounting distinguishing deleted resources from absent no-ops across repeated teardown attempts. Key existence and tombstone state are verified through exact Direct Get checks before purging KV keys, ensuring repeated deprovisioning reports zero deleted entries. Partial broker failures record refused resources and raise DeprovisionError with partial accounting rather than discarding earlier progress.
