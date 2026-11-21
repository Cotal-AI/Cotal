---
"@cotal-ai/core": patch
---

Move the anycast take responder state into the internal anycast part, the pending durable leaves into the durable membership part, and the pending boot joins into the boot membership part, so each field has one owner instead of being read through getter and setter callbacks on `CotalEndpoint`. The package exports, public methods and wire behaviour are unchanged.
