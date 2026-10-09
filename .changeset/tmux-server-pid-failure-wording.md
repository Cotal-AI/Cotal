---
"@cotal-ai/tmux": patch
---

`tmux.serverPid`, and so `TmuxRuntime.reap`, now throws a `tmux: couldn't read the server pid: ...` error with the original error as its cause when tmux cannot be queried, as the driver's other queries do. It used to rethrow the bare `Command failed: tmux display-message -p #{pid}` or `spawnSync tmux ENOENT` error. A server that is not running still reads as no server.
