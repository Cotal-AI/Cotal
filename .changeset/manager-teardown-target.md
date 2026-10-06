---
"@cotal-ai/manager": patch
---

The manager's teardown chain (`trackDeprovision`, `deprovision`, `driveDeprovision`) and `startAgent`'s spawn-rollback value now share one named `TeardownTarget` type in place of four inline copies of the same object shape. A field the chain needs is declared once, so a copy can no longer fall behind unnoticed when a hop passes the value on as a variable. No behavior changes.
