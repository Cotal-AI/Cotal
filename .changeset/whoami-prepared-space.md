---
"@cotal-ai/cli": patch
---

`cotal whoami` on a space that is prepared and not started now reports the identity its folder's trust gives it, with `server` and `mode` null and a note to start it with `cotal up`, instead of refusing with `TARGET_UNAVAILABLE`.
