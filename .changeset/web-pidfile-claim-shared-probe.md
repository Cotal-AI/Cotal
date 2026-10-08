---
"@cotal-ai/web": patch
---

`cotal web` now judges an existing `web.pid` with the workspace's `parsePid` and tri-state `probeLiveness`, as `cotal down web` does. It calls the record stale and points at `cotal down web` only when the file is empty or its pid is proven gone. Content that is not a pid (`abc`, `12.5`, `0`, `-1`, an out-of-range number), or a pid whose liveness the kernel will not report, is now refused as possibly fronting a running process. Before, the dashboard called it stale and advised a cleanup that `cotal down web` then refused. An extension-removal reservation in `web.pid` is judged by the same rule. A detached launch also no longer reads an unconfirmed liveness answer as its child having exited, so termination signals the child instead of skipping it.
