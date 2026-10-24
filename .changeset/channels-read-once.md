---
"@cotal-ai/cli": patch
---

`cotal up --channels` reads its seed file once. A seed given as a pipe or a FIFO, such as `--channels <(…)`, was opened three times, so the second read found it empty and refused valid JSON, or waited forever on a FIFO fed once.
