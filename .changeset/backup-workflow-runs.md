---
"@cotal-ai/core": patch
"@cotal-ai/cli": patch
---

A full backup of a static-auth or open mesh now holds the workflow runs: the WFJ step journal, the
records store and the run admission store. A run that waited at a checkpoint or a timer is back after
a full restore, and the manager takes it over. Before, a full restore recreated those stores empty,
so every run was gone. The records store's endpoint authority rows roll back to the cut with the
runs. A user-mode full backup still holds no run store, because the records store's lifecycle heads
name credential rows in the auth store, which a backup does not carry. Artifacts use the manifest
format `cotal-space-backup/v2`; a `v1` artifact still restores and holds no workflow run. Each
restore now lists what it restored and what it recreated empty, and says why when it holds no run.
Backup also accepts the stopped goal-index watcher of an open mesh's manager.
