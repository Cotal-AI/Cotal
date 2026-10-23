---
"@cotal-ai/connector-opencode": patch
---

On OpenCode 2.x, a prompt typed while a turn still carries a peer batch now goes out without peer messages, as on 1.x, and the messages that arrived meanwhile are driven once that turn ends. Before, the prompt hook replaced the open batch with everything in the inbox, so a message already submitted went out a second time and the earlier turn's end acked messages that no turn of their own had carried. A message that arrives after a native prompt took the waiting batch now also waits for that prompt's turn, instead of going out in a second turn that carried that batch again. Both OpenCode lines now keep the batch in one shared owner.
