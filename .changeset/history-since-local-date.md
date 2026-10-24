---
"@cotal-ai/cli": patch
---

`cotal history --since` reads a bare date as local midnight, as a date and time without an offset already were, and refuses a date that is not on the calendar. The report names the local time and the ISO instant a time `--since` resolved to.
