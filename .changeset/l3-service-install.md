---
"@cotal-ai/cli": patch
"@cotal-ai/manager": patch
---

Add `cotal service` (install/status/uninstall): run the manager as a user service that survives logout and reboot. Linux installs a systemd user unit per mesh, macOS a launchd agent; other platforms fail with a message naming what is missing. The unit runs a bare `supervise` with mesh facts in a 0600 EnvironmentFile, a private COTAL_HOME (with the mesh registry entry snapshotted into it), and connectors pre-seeded synchronously by the installer. `supervise` reads COTAL_SPACE/COTAL_SERVER from the environment when the flags are absent, and pins its workspace root so a unit's WorkingDirectory owns the pidfiles.

Every path-derived value the unit writes (WorkingDirectory, EnvironmentFile, ExecStart tokens) is escaped for systemd percent specifiers, so a mesh root containing `%` starts over its real path instead of a path systemd rewrote while install reported success. Uninstall and status require the unit's recorded mesh to be present (and, for uninstall, to match the named mesh); a unit that carries the provenance marker but no recorded mesh is refused rather than treated as the requested mesh.
