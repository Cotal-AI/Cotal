---
"@cotal-ai/cli": patch
---

When a foreground spawn refuses a credential file, its managed alternative now tells you to omit the file and select a registered space you can access. Detached mode alone cannot authorize the launch. For a runtime request without an interactive terminal, the advice now requires detached mode rather than offering a Manager pin alone.
