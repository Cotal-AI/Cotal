---
"cotal-ai": patch
---

On macOS and Linux, append the per-user installer folders declared by seeded and installed connectors (`~/.local/bin`, `~/.opencode/bin`, and `~/.pi/agent/bin` for the built-in connectors) after the caller's `PATH` when writing or refreshing the background service's systemd unit or LaunchAgent plist, so the running daemon and hosted Managers find agent applications installed into those folders after service setup without setting up or restarting the service again.
