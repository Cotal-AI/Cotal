---
"@cotal-ai/cli": patch
---

A team read or preview that completes exits 0. `cotal team`, `team show <id>`, `team deploy --dry-run`,
`team boot --dry-run` and `team remove <id> --dry-run` exited 4 with a failure line on stderr, although
each one answered. Their JSON still marks `completeness` as `partial`, and the report has a line saying
what the read does not establish.
