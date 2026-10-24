---
"@cotal-ai/cli": patch
---

`cotal up` on a controller stack and `cotal history` now warn `STORE_DAMAGE_LOGGED` when the space's broker on this machine logged damage in a stored file since it started, quoting the broker's warning. The history read stays complete, because it read the stream as the broker serves it. A broker whose log is not on this machine is not checked. Both used to report nothing while history returned fewer messages.
