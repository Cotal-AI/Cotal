---
"@cotal-ai/manager": patch
---

Replace the ten-line deliberate-stop comment block in `Manager.awaitReadiness` with its settle rule: the despawn path owns the goal's `cancel` terminal, and the promise still settles as the `deliberate` variant because the readiness timer is already cleared and the spawn's lifecycle ticket is released only on settle. Runtime behavior is unchanged.
