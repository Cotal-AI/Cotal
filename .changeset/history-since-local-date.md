---
"@cotal-ai/cli": patch
---

`cotal history --since` reads a date alone as local midnight, as it reads a date and time with no
offset as local time. A date alone was read as UTC midnight, so east of UTC `--since <today>` could
start in the future and return nothing. The text and `--plain` reports print the resolved cutoff
under `Since`.
