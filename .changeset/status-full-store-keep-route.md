---
"@cotal-ai/cli": patch
---

`cotal status` on a space whose store is over its `--max-file-store` cap now names the route that keeps the history, as `up` and `down` do: `kill -TERM <pid>` for the stack's manager on this host, then `cotal down --yes` and `cotal up --max-file-store <bytes>` with a larger cap. It used to offer only `cotal history clear`, which purges the history.
