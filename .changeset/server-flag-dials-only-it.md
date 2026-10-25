---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

A command given `--server` and no `--space` no longer dials the brokers this machine records at
other addresses before it dials the one `--server` names. Its liveness sweep now probes only the
records at that address, the only ones its resolve reads, so `history`, `who`, `ps` and the other
commands that resolve this way connect to the `--server` address alone. `status --server <address>`
no longer checks the selected space's recorded address when `--server` names another, and that
row reads `not checked`.
