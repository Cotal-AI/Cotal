---
"@cotal-ai/cli": patch
"cotal-ai": patch
---

Start a stopped owned daemon service during manual `cotal update --self` across Linux, macOS, and Windows and require the daemon to answer at the target version before completing the update. When no daemon is running before a manual update, the updater checks that the recorded service belongs to this installation and is enabled before starting the systemd user service, LaunchAgent, or Windows scheduled task, leaving disabled or foreign-owned services stopped and waiting for readiness on enabled owned services instead of accepting a reconciliation child exit code alone.
