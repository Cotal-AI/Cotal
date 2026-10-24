---
"@cotal-ai/cli": patch
---

`cotal doctor auth` now names a label file's grants in the `auth mint <label> --replace` it gives
for an unbounded or expired file: its read and post channels as `--allow-subscribe` and
`--allow-publish`, and its role as `--role`. The replacement is a new key, which holds only the
grants its mint names, so following the old hint as written minted a credential that could read and
post to no channel. The revoked-file hint already named them.
