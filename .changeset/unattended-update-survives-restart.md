---
"cotal-ai": patch
"@cotal-ai/cli": patch
---

Fix the unattended update on Linux, which could leave the daemon restarting in a loop.

The daemon restarted into the new version while its own update was still running. The service restart stopped the update midway, and the daemon then refused to start. The update now finishes and exits before the daemon restarts, the daemon never restarts for a new version while its own update runs, and a daemon that finds a paused update starts and names `cotal update --self` in its status.

If a computer is already affected: stop the daemon service, check that no `cotal update` is running, remove `.cotal-update-child` from npm's global `node_modules` directory, and run `cotal update --self`.
