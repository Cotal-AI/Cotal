---
"@cotal-ai/cli": patch
---

`cotal service install` on Linux no longer reports success for a unit that will not start at boot. Without lingering, systemd starts no user manager at boot, so the enabled unit stayed inert until the user logged in, while install printed `✓ service installed` and only a hint to pass `--linger`. Install now checks lingering before it writes anything and, when lingering is off, fails with the root command that turns it on (`sudo loginctl enable-linger <user>`). A `--linger` that logind refuses fails the same way and no longer leaves the unit installed and enabled behind the error. `service status` prints the same command while lingering is off. A Linger query that fails or prints anything but `yes` or `no` (logind unreachable, no `loginctl`) is not read as off: install refuses with the query's own error and enables nothing, and `service status` shows lingering as unknown with that error.
