---
"@cotal-ai/cli": patch
---

At `--limit 1000`, `cotal history` no longer tells you to raise `--limit` to read further back; it
says history reads at most the newest 1000. With older retained messages behind the window,
`--from` and `--grep` say they searched only the messages read.
