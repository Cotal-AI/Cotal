---
"@cotal-ai/cli": patch
---

`/leave` of a channel the chat session never joined now answers `not on #<channel>`. It used to say
`still on #<channel>`, as if the session were reading that channel.
