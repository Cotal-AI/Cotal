---
"@cotal-ai/manager": patch
---

A static lifecycle's retirement now deletes its broker durables and read-ACL row even when its credential file cannot be removed. The cleanup used to stop at the first failed removal, so a creds path the manager could not delete (a directory in its place, a read-only parent, or a secret store whose delete rejects) left the lifecycle's `dm_` and `dlv_` durables and ACL row on the broker, and every retry stopped at the same step. Each step now runs and the failures are reported together, so the name stays held until the file is removed.
