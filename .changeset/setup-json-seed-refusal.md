---
"@cotal-ai/cli": patch
---

`cotal setup --json` now reports a failed connector seed as one JSON document on stdout, with no text failure line on stderr.

The seed runs before the command, so the refusal used to print one text line and leave stdout empty. A command that asks for JSON now gets the same envelope any later refusal writes. When npm is not on PATH, the reason says that instead of a raw spawn error with an embedded newline.
