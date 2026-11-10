---
"@cotal-ai/core": patch
"@cotal-ai/workspace": patch
---

A space member who may spawn agents can now list them with `cotal ps` and read them with `cotal status <agent>` on a user-auth mesh.

A `spawn`-scoped `manager-caller` view carries `ps` on its one pinned Manager instance, beside `status`, `models` and `resolve-cwd`. The Manager answers it with the caller's own agents only unless the caller holds `admin`. `slots` still needs `admin`, and the standing agent `spawn` set is unchanged. A refused `ps` now names `spawn` or `admin` as the scope it needs.
