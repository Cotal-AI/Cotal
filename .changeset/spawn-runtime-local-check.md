---
"@cotal-ai/cli": patch
---

`cotal spawn -d --runtime <name>` refuses `auto` before anything is sent. When the launch goes to this root's own manager, pinned or the only one running, an unknown, uninstalled or unreachable runtime is refused `DEPENDENCY_UNAVAILABLE` before the launch is sent, through the lookup `up --runtime` uses, and a known runtime's remedy names its `cotal ext add` package. A launch that may reach a manager on another host still sends the name, and that manager checks its own extensions. `--dry-run` shows the requested runtime, carries it as `result.requested.runtime`, and reports in `result.runtimeCheck` which host it checked and whether that host can run it, with a `RUNTIME_UNAVAILABLE` warning when it cannot.
