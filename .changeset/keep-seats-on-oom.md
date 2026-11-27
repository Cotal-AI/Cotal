---
"cotal-ai": patch
---

Set `OOMPolicy=continue` on the Linux `cotal-daemon` systemd user unit so an out-of-memory kill of one seat child process does not cause systemd to stop the daemon, Manager, and other running seats, and upgrade an unmodified default-home `cotal-daemon.service` unit in place during `cotal update` without restarting running seats. The update that installs this release leaves the existing unit alone, and the next `cotal update` run by this release writes `OOMPolicy=continue`.
