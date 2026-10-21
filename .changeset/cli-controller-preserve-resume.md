---
"@cotal-ai/core": minor
"@cotal-ai/workspace": minor
"@cotal-ai/manager": minor
"@cotal-ai/cli": minor
---

`down --preserve-state`, bare `up`, `backup restore` and `up --restore` now work on a controller-owned stack.

The preserve first runs the scope check bare `down` runs, so another live service instance in the space, a legacy pidfile process or a shared broker address refuses before any effect, and a retry of a committed cut checks again before any further stop. It then proves, with no effect, that the stack's manager instance serves the preserved-exit stop contract; an older manager refuses before any stop. It stops the manager with a preserved-exit request that retains its agents, then auth and the broker, and records each member's own stop receipt in the cut. A preserved manager, and one launched for a resume that has not committed, still answers `status` as a counted read, so the preview and resume readiness can attribute it.

Bare `up` resumes a ready cut through its recorded members. Each start is journaled before it is made, a member whose earlier launch is unproven holds, and after the manager commits only the manager starts again, once its exit is receipted, with the commit token as a protected file.

A controller restore keeps the broker definition for the preserved store's own path. For another `--store-dir` it journals and then writes an attempt-owned broker configuration and points the definition at it; the broker starts as a new journaled instance and the cut's old broker record is removed once the restore is active. Rollback returns the definition to the original configuration as a new revision before the store, and any unattributed revision holds. Backup and restore also require the broker configuration to match the cut launch's recorded digest. A settled active controller restore no longer fences controller `down` or `up`, including `up --no-manager`, or the broker and manager services; `down` and `up` name it in their receipts. While any other maintenance journal is held, the manager service launches only a resume or restore attempt's own journaled manager start, as the broker service does, and a broker or manager `service restart` whose start would be refused refuses before it stops anything. `down --preserve-state` and `team boot` still refuse an active restore and now say why: a new cut needs the restore journal retired with `backup cleanup-fallback`, and a team boot never resumes a stack whose manager already ran.

On a controller root, backup, reset store and reset space count a stack member as running unless its process is gone with its own stop receipt. `@cotal-ai/core` exports `brokerJetStreamBlock`.
