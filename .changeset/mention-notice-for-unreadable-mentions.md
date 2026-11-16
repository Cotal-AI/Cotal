---
"@cotal-ai/core": patch
"@cotal-ai/connector-core": patch
"@cotal-ai/connector-hermes": patch
"@cotal-ai/pi": patch
---

A channel post that mentions an agent who may not read the channel no longer drops that mention silently. On an authenticated mesh the delivery daemon sends the post's sender a mention notice that names those agents, so the sender can reach them another way. The connectors show it as `[mention notice from the delivery daemon]`, and Hermes runs it in its own `notice:mention` chat.
