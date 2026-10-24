---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

A restore that leaves the workflow runs out now says so and keeps their only copy. A registry-only
restore, and a full restore of a user-mode artifact or one made before full backups held runs,
starts the runs empty while the store it set aside still holds them. The restore receipt now names
that store, with a `RUNS_NOT_RESTORED` warning for a full restore. `backup cleanup-fallback` and
`clean restore-fallback` delete it only with `--discard-history`, as they already did for a
registry restore's history, and their preview, refusal and receipt name the workflow runs. The
next step that `cotal status` shows for such a restore includes `--discard-history`, and a full
restore that brought the runs back shows the plain cleanup.
`backup create` says when its artifact holds no workflow runs.
