---
"@cotal-ai/runtime": patch
"@cotal-ai/connector-core": patch
---

`cotal run show` no longer prints a long answer value whole in its Answers table. A value longer than 120 characters is cut, and a line says so and points to `--json`, which carries it whole. Before, one 100 KB answer padded every row of the table to its width, and the view printed about 300 KB for three rows.
