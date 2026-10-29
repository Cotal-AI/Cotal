---
"@cotal-ai/cli": patch
---

An `up -d` or refresh whose control plane is degraded, such as one whose delivery daemon exited before the boot finished, no longer offers `cotal spawn` under Next, which needs that control plane; it offers only the stop, as the other degraded outcomes do. The line `cotal down` prints while it waits out a daemon's lease row with no pidfile now wraps on a narrow terminal like the CLI's other stderr lines.
