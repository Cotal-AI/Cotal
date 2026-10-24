---
"@cotal-ai/cli": patch
---

`cotal history` shows at most the first 500 characters of a message in its text and `--plain` rows,
including under `--follow`, and marks a cut row with the message's size. `--limit` bounds how many
messages are read, but a row printed the whole text, so three large messages printed megabytes.
`--json` still carries the whole text.
