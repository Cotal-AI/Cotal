---
"cotal-ai": patch
---

On macOS and Linux, append the per-user installer folders declared by seeded and installed connectors (`~/.local/bin`, `~/.opencode/bin`, and `~/.pi/agent/bin` for the built-in connectors) after the caller's `PATH` when writing or refreshing the background service's systemd unit or LaunchAgent plist. On Linux, newly installed or refreshed services find agent applications added to those folders later without another setup or restart. Existing service units and plists keep their recorded `PATH` until refreshed by `cotal daemon setup` from a terminal that finds a newly installed application (or by the desktop app's application refresh).
