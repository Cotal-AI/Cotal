---
"@cotal-ai/cli": patch
---

The terminal chat view refuses `:to` commands instead of posting them to the channel. It clears the previous recipient and opens the picker so the next private message cannot go to that channel. Completing an earlier send or command preserves the current recipient and draft.
