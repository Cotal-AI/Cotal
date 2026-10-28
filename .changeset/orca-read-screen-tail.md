---
"@cotal-ai/orca": patch
---

`orca.readScreen` now checks that `terminal.tail` in the `orca terminal read --screen --json` response is an array of strings and throws an error naming the command and terminal handle when it is missing or malformed, instead of failing with a raw `TypeError` on dereference.
