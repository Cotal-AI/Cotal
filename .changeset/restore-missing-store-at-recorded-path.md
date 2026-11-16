---
"@cotal-ai/cli": patch
---

`backup restore --accept-missing-source` rebuilds a missing preserved store at the path its cut records, a custom `--store-dir` included, and the restored space starts on that store. Before, a restore with no `--store-dir` chose `.cotal/nats` and failed `OPERATION_UNKNOWN`, so the recorded path had to be passed again. A `--store-dir` naming another path is now refused before staging.
