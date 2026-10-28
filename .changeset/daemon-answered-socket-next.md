---
"cotal-ai": patch
---

`cotal daemon serve` refused for a socket with the recorded device and inode numbers that another process answers on now says that process is listening at that path and the daemon does not start until it releases it, and Next names `ss -xlp` and `fuser <path>` to find it. Next used to say to run `cotal daemon status`, which gives neither outcome it described. The same `serve` run again now says the lock record names no socket because a clean stop or a refused `serve` clears it, instead of calling the socket one this daemon home never published. `cotal daemon status` refused `PEER_NOT_LOCK_OWNER` or `SOCKET_WRONG_MODE` now gives a step to take: find the process listening at the socket with `ss -xlp`, and run the command with that daemon's `COTAL_HOME` or stop the process and start the daemon with `cotal daemon serve`.
