---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

A refused slash command in chat clears the input line.

The refusal stays in the transcript, and the next command is typed on an empty line. A line kept because the session is not connected, a send is in flight, or no recipient is chosen stays. `/reply` with text says that it only chooses the recipient and that the message is typed after it.
