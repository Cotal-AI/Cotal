---
"@cotal-ai/cli": patch
---

`cotal channel members` on an open mesh now refuses with `UNSUPPORTED`, exit 2, and says why: the delivery service writes the membership feed, and an open mesh runs none. It used to report an unestablished census, exit 4, and tell you to check a delivery service the mesh does not run. The remedy names `cotal who` for who is present.
