---
"cotal-ai": patch
---

Set `OOMPolicy=continue` on the Linux `cotal-daemon` systemd user unit so an out-of-memory kill of one seat child process does not cause systemd to stop the daemon, Manager, and other running seats, and upgrade unmodified existing Linux daemon units in place during `cotal update` without restarting running seats.
