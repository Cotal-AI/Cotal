---
---

A smoke suite that cannot run on the current platform now ends through `skipSuite(reason)`, which prints `COTAL_SMOKE_SENTINEL skipped=<reason>`. The shard lists the suite as skipped and adds no cell to its total. Five Hermes connector suites used to print `cells=1 passed=1` on Windows and two more printed a `✓` line, so the shard counted seven suites that never ran as passing cells. All ten Hermes suites that skip on Windows now use the skip form. This changes repository tooling only; no published package changes.
