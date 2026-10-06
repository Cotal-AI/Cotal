---
"@cotal-ai/cli": patch
---

A foreground user-mode `cotal spawn` whose auth preflight fails now attempts every rollback step even when a file removal throws, so the agent's durables and ACL row are always deprovisioned and the `agent auth preflight failed` refusal keeps its cause with each failed step appended. The remote arm appends a failed removal to the refusal instead of replacing the cause, and both arms' exit cleanup runs every step and reports what it left behind.
