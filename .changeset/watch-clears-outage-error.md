---
"@cotal-ai/cli": patch
---

`cotal watch` and `cotal console` drop the "Observer reported an error" state once presence is current again after a broker restart, instead of keeping it until they are restarted.
