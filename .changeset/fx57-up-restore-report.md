---
"@cotal-ai/cli": patch
---

`cotal up` now names a manager it restored, distinctly from one it found already running (issue #883). `ensureManager` returns `started`/`pid` instead of collapsing the reuse and launch branches into the same `{ running: true }`, `ensureDelivery`/`ensureControlPlane` carry the same fields through, and a refresh that restores a missing manager prints `✓ restored in the background: manager (pid N)`; a refresh that finds everything running still prints only the `✓ mesh "<space>" already running` line.
