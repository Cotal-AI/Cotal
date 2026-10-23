---
"@cotal-ai/runtime": patch
---

`cotal run show` and `run journal` list a pause under `Needs an answer` only while its last journal row is pending, and offer `answer` as a next step only when one is open. A checkpoint that was answered or expired kept its earlier pending rows in the journal, so completed and failed runs still listed it as needing an answer. A pause settled with an accepted answer now prints that answer's value, answerer, artifact when present, time and answer id, then one `amended` line per later amendment, as the docs describe; before, only `--json` carried them.
