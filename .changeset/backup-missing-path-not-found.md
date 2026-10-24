---
"@cotal-ai/cli": patch
---

`backup create` into a folder that does not exist, and `backup restore` or `up --restore` of a path
that names nothing, now refuse `TARGET_NOT_FOUND` (exit 2) before they take any lock, naming the
path and whether the folder or the artifact is missing. Create refused `LIFECYCLE_BLOCKED`, saying
no eligible preserved cut was established, with a raw `ENOENT` as detail and a Next about
maintenance state. Restore exited 3 `OPERATION_UNKNOWN` with the raw `ENOENT`.
