---
"@cotal-ai/cli": patch
---

Channel reports consistently mark inherited replay, window and delivery settings.
The channel list and detail view use `inherited` for values without a saved override, including built-in policy values. Explicit settings remain unmarked even when they match the defaults.
