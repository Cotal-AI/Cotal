---
"@cotal-ai/acp": minor
"@cotal-ai/cli": minor
"@cotal-ai/manager": minor
"@cotal-ai/workspace": minor
---

`cotal acp` now starts this machine's manager for the space when no manager may start a new thread's agent, or when none of yours runs on this machine, and that manager stops itself after 10 minutes with no agents. The bridge runs `cotal manager start --idle-exit 600` and says so in the thread in one line. Another computer's manager runs a thread's agent only when the thread's Machine option names it. Threads that open at the same time share one start, and a failed start fails the new thread with its reason. A listed manager whose rail the broker reports empty, such as one whose computer is gone, is not offered. `cotal manager start` and `cotal service start manager` take `--idle-exit <seconds>` for that start only: the manager stops, and deregisters, once it has held no agent, call, workflow run, preservation or resume for that long. `status` shows the value on an `Idle exit` row. A start with a different value while the manager runs refuses `LIFECYCLE_BLOCKED`. `@cotal-ai/workspace` probes a signed-in caller's pinned manager rail on the rail its credential was issued for.
