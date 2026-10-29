---
"@cotal-ai/cli": patch
---

On a store over its `--max-file-store` cap, the Next of a `cotal up` whose member cannot start, and of `cotal status`, now names only `cotal down --yes` and `cotal up --max-file-store <bytes>` with a larger cap, after `kill -TERM <pid>` for a manager that still runs. They no longer lead with `cotal history clear`. A purge frees only the channel history's bytes, so on a new space whose cap is below the stack's own first writes it purged nothing and the store stayed full, and on a space with history it could delete all of it without making room.
