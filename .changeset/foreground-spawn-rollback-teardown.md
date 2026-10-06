---
"@cotal-ai/cli": patch
---

A foreground user-mode `cotal spawn` whose auth preflight fails now attempts every rollback step even when one fails, so a failed file removal no longer skips the deprovision of the agent's durables and ACL row. The `agent auth preflight failed` refusal keeps its cause and appends each step that failed, whatever value the step rejected with. The remote arm appends a failed removal instead of replacing the cause, a managed handoff's fixed refusal names the failed steps without their errors, and both arms' exit cleanup runs every step and reports what it left behind.
