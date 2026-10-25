---
"@cotal-ai/cli": patch
---

`cotal status` in the folder of a static-auth stack whose broker or manager exited now puts
`cotal up` first under Next, which starts it again on the recorded address and store. Before, the
manager's stale pidfile was followed only by `setup`, `ps` and `use`. A broker's stale pidfile left
`clean store --force`, which removes the stored history, as the only recovery command named.
