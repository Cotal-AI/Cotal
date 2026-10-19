---
"@cotal-ai/orca": patch
---

`orca.readScreen` now throws an error naming the `terminal read` call and the terminal handle when the Orca CLI answers with an ok envelope whose `terminal.tail` is missing, `null` or not a list of strings. Before, those payloads escaped as a raw `TypeError` such as `Cannot read properties of null (reading 'join')`, so the startup-confirm watch ended the seat with a message that named no backend call and no terminal.
