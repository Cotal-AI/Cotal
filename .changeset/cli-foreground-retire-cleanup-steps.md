---
"@cotal-ai/cli": patch
---

A static-auth foreground `cotal spawn` now deletes the agent's broker durables and read-ACL row when it exits even if its creds file cannot be removed. The retirement used to stop at a failed file removal (a read-only creds directory, a directory in the file's place), so the agent's `dm_` and `dlv_` durables and ACL row stayed on the broker and the removal error escaped the spawn. The secret delete, the file removal and the broker teardown now each run, and every failed step is reported in one line.
