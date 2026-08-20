---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

Announce the operator-global seed-store payload write, and its deletions, on the provenance channel. `cotal up` and the built-in-connector reconcile re-seed `~/.config/cotal/seed/store/<version>`, which is a machine-wide action (shared by every space, project directory, and checkout on the machine, moved only by `$XDG_CONFIG_HOME`), yet the store write was previously silent. It now emits a `wrote operator-global seed store payload` provenance line naming the path on each materialization, so re-seeding from a non-released checkout reads as the machine-wide write it is. The idempotent reuse path stays silent.

The same reconcile also garbage-collects unreferenced store generations, and that was silent too. A new `removed` verb on the provenance channel names every directory the collector deletes, because a silent delete is worse than a silent write: the write at least leaves the thing it made, while the delete leaves nothing to notice. The announce rides stderr with no failure policy, so a closed stderr keeps the write and loses the line; that bound is stated at the call site and in the config reference, which also documents the isolation mechanism.
