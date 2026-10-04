---
---

Smoke suites no longer leave `cotal up --detach` stacks running after they exit. The first `recordSmokeSandbox` call in a suite now starts a small watchdog that outlives it, and when the suite's process ends, however it ends, the watchdog kills every process still working inside a recorded root. A suite whose `cotal down` refused, that failed mid-way, or that tsx killed while it waited in `spawnSync` used to leave a broker and its daemons running in its temp root, often after the suite had already deleted it. The watchdog finds processes through Linux procfs, so nothing is watched on other platforms. On Linux a root whose path contains a newline is refused, because the watchdog reads one root per line.
