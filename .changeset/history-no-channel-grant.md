---
"@cotal-ai/cli": patch
---

`cotal history` with a `--creds` credential that may read no channel, such as an agent credential from `cotal auth mint` with no `--allow-subscribe`, refuses before it reads with "its history grant is no channel" and the mint step that grants one, instead of the broker's raw permission subject.
