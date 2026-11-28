---
"cotal-ai": patch
---

`cotal daemon stop` turns off automatic start and then stops the background service. The service, its sign-in and its spaces stay in place, and it stays stopped through sign-out and a restart. `cotal daemon start` turns automatic start back on and starts it. While agents are running, stop names them and asks; without a terminal it waits for `--yes`. `cotal daemon status` says you stopped it and names `cotal daemon start`.
