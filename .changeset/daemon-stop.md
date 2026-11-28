---
"cotal-ai": patch
---

`cotal daemon stop` turns off automatic start and then stops the background service. The service, its sign-in and its spaces stay in place. `cotal daemon start` turns automatic start back on and starts it. While agents are running, stop names them, including a Manager that is still starting, and asks. Without a terminal it refuses with exit 1 unless `--yes` is given. `cotal daemon status` says you stopped it and names `cotal daemon start`.
