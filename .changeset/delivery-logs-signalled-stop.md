---
"@cotal-ai/delivery": patch
---

The delivery daemon now writes `• delivery: received SIGTERM, exiting (space <space>, shard <n>)` (or `SIGINT`) to its log before it tears down on a signal. A stop from `cotal down`, a service stop or Ctrl-C used to leave the log ending on routine work, which looked the same as a silent death. Every other deliberate exit already logged its reason. A SIGKILL, including the kernel OOM killer, still leaves no line.
