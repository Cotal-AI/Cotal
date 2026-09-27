---
"@cotal-ai/cli": patch
---

`cotal status` asks the manager's service endpoint before printing its row, so a live manager process whose rail does not answer reads `not serving` instead of `running`, and the `--components` probe mints its lease-read credential with a lifecycle uid so it is no longer refused on a static mesh (#2073).
