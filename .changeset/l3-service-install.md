---
"@cotal-ai/cli": patch
"@cotal-ai/manager": patch
---

Add `cotal service` (install/status/uninstall): run the manager as a user service that survives logout and reboot. Linux installs a systemd user unit per mesh, macOS a launchd agent; other platforms fail with a message naming what is missing. The unit runs a bare `supervise` with mesh facts in a 0600 EnvironmentFile, a private COTAL_HOME (with the mesh registry entry snapshotted into it), and connectors pre-seeded synchronously by the installer. `supervise` reads COTAL_SPACE/COTAL_SERVER from the environment when the flags are absent, and pins its workspace root so a unit's WorkingDirectory owns the pidfiles.
