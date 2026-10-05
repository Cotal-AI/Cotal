---
"@cotal-ai/core": patch
"@cotal-ai/manager": patch
---

A registration refused because another instance holds the endpoint governance slot now carries an `ai.cotal.ep.foreign-slot-held` detail with the holder's instance id and the condition that refused (`no-seam`, `unreadable`, `garbled`, `behind` or `in-flight`). A remote manager reads that detail instead of matching the refusal's message, and asks its host to reconcile the holder only when the holder's gate is still frozen at the slot's stamp. Before, it asked the host for every foreign-slot refusal, so a holder gate that was missing or read below the stamp surfaced the host's "no endpoint gate" or "not frozen" refusal in place of the registration's own, and rewording the core message would have turned the recovery off with no failing check.
