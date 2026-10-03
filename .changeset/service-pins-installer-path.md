---
"@cotal-ai/cli": patch
---

`cotal service install` now pins the installing shell's `PATH` into the unit: a `PATH` line in the systemd `EnvironmentFile`, and a `PATH` key in the launchd plist's `EnvironmentVariables`. The unit used to inherit the service manager's own `PATH`, which usually lacks `~/.local/bin` and Homebrew, so a service-run manager reported a harness such as `claude` unavailable at boot even though the shell that installed it resolved the binary. A relative `PATH` entry, including an empty one, is resolved against the directory `install` ran from, because the unit starts in the mesh root where the same spelling names another directory. An entry with a `..` segment is pinned as the directory the shell reaches through it, with symlinks followed, and refuses the install when it reaches none. An unset `PATH` now refuses the install.
