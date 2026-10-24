---
"@cotal-ai/connector-core": patch
---

The CLI reference says what `run ps --json` and `run journal --json` write: one envelope on
stdout, with rows under `result.items` or the run under `result.view`, and nothing on stderr. It no
longer describes one JSON object per line with the run header on stderr.
