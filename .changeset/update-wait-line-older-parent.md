---
"cotal-ai": patch
"@cotal-ai/cli": patch
---

`cotal update --self` from a release before 0.166.0 prints the daemon wait line again. The reconcile step of the new version stayed quiet whenever an updater had started it, on the assumption that the updater prints `machine daemon: waiting up to 120s for Cotal <version> and its hosted Managers before the continuity check` afterwards. An updater from 0.164.10 does not wait there, so the update waited up to two minutes without saying why. The updater now tells its reconcile step that it waits, and the step stays quiet only then.
