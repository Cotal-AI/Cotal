---
"@cotal-ai/cli": patch
---

Announce the operator-global seed-store payload write on the provenance channel. `cotal up` and the built-in-connector reconcile re-seed `~/.config/cotal/seed/store/<version>`, which is a machine-wide action (shared by every space, project directory, and checkout on the machine, moved only by `$XDG_CONFIG_HOME`), yet the store write was previously silent. It now emits a `wrote operator-global seed store payload` provenance line naming the path on each materialization, so re-seeding from a non-released checkout reads as the machine-wide write it is. The idempotent reuse path stays silent. The config reference documents the isolation mechanism.
