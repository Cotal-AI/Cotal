---
"cotal-ai": patch
---

Set `OOMPolicy=continue` on the Linux `cotal-daemon` systemd user unit so an out-of-memory kill of one seat child process does not cause systemd to stop the daemon, Manager, and other running seats, and upgrade an unmodified default-home `cotal-daemon.service` unit in place during `cotal update` without restarting running seats when no loaded user unit has a pending reload. `cotal update` and automatic updates leave the existing unit alone during the update that installs this release and write `OOMPolicy=continue` on the next update run by this release, while upgrading through the installer script writes `OOMPolicy=continue` during that install.
