---
"@cotal-ai/cli": patch
---

`cotal up` over a manager pidfile that holds no pid now names steps that work. Its Next offered only `cotal down`, which refuses that pidfile and leaves the broker running. It now names `rm <pidfile>`, to run once `cotal ps --space <space>` finds no manager running, and then `cotal up`, or `cotal up --no-manager` after a start with that flag. The `! control plane degraded:` report wraps on a terminal like other warnings, puts each sentence on its own line, and says what happened without internal component names. A refresh of a running stack no longer prints `starting this folder's stopped stack in the mode it last ran: open`; that line and the one naming the address it last ran at appear only when `up` starts a stopped stack.
