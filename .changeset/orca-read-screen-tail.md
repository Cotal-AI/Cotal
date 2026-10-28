---
"@cotal-ai/orca": patch
---

Validate `terminal.tail` in `orca.readScreen` so malformed `terminal read --screen --json` responses throw an error naming the command and terminal handle instead of a raw `TypeError`.
