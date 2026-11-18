---
"@cotal-ai/connector-core": patch
---

`cotal_send` no longer calls an existing channel new when the channel list could not be read, for example while the connection comes back after a space restart. The post still goes out, and the result says whether the channel already existed could not be checked, with the read's error.
