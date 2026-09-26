---
"@cotal-ai/connector-core": patch
---

Refuse a presence write admitted after stop() began, instead of queueing it behind departure: departure's offline publish is now itself a presence-chain entry ordered after every write already admitted, and any write admitted after it rejects at once with a fixed error, so a straggler can neither sit out the connect grace behind the chain nor land after the offline record (#636).
