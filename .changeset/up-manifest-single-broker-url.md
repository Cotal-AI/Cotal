---
"@cotal-ai/cli": patch
---

`cotal up -f` and `cotal team boot` now refuse an effective `broker.servers` list that names more than one broker URL, naming the source (`broker.servers` or `--server`) and the single-bind rule instead of failing with a bare `Invalid URL`.
