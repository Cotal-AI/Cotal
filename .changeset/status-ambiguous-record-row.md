---
"@cotal-ai/cli": patch
---

`cotal status` now names an ambiguous process record on that component's row and prints the rest of the report. When a root held both a current record such as `manager.<hex>.pid` and its pre-upgrade name such as `manager.pid`, which a manager that crashed before the upgrade leaves behind, `status` printed `✗ both … exist … ambiguous process record; remove the stale one` and exited 1 before the remaining process rows, Recorded Meshes and Selected Mesh. `status --components` stopped the same way at the first component. The folder row now reads `pidfile unreadable` with that error, the component row reads `refused`, and the other rows still print.
