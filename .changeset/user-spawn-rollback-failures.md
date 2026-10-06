---
"@cotal-ai/manager": patch
---

A user-mode spawn that fails after its grant is written now rolls back every step and says what it left behind. The rollback ignored a failed grant revoke and failed secret deletes, and a credential file that could not be removed (for example a directory at the health path) aborted it before the broker teardown, leaving the agent's durables and ACL row on the broker and replacing the refusal with the raw filesystem error. Each step now runs whatever an earlier one did, and the refusal keeps its `agent auth preflight failed` sentence and appends each failed step. Despawn teardown no longer stops at a file it cannot remove: it still revokes the grant and deletes the broker footprint, then reports the file and keeps the name held. A hosted spawn whose staged token cannot be deleted from the store after the host re-keys it is refused instead of reporting success.
