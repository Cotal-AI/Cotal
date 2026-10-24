---
"@cotal-ai/cli": patch
---

`cotal ps` across several managers shows the host each answering manager reports, as `manager <id> · reports host <host>`, and `--json` adds it as `reportedHost`. It is the manager's own claim, asked under one 2-second limit, and a missing host leaves the census unchanged.
