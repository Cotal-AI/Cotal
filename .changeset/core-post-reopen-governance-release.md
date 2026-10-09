---
"@cotal-ai/core": patch
---

A frozen registration finished after its spec write committed no longer fails once its reopen commits. The same-op resume in `registerServiceInstance` and the `cotal reconcile-gate` repair used to throw when the governance slot release or the progress-cursor read after that reopen failed, although the gate was already open at the new epoch with the spec published, and a caller that retried the resume advanced the epoch a second time. The release is now best-effort on both completing paths, as it already was on the normal registration path: a slot it leaves is behind the live gate generation, which deregistration treats as orphaned and the next registration replaces.
