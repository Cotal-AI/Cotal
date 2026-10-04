---
---

A smoke shard that stops at its first failing suite now prints how many of its planned suites started, and under GitHub Actions it annotates the job with the failing suite and that count. The Windows smoke lane runs the shard with `continue-on-error`, so its job reported success over a red shard while most of the plan never ran, and the plan listing in the log was the only place those suites were named. This changes repository tooling only; no published package changes.
