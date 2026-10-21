---
"@cotal-ai/connector-core": patch
---

Make `cotal_orientation` identify the current session without conflating its labels. The card now reports whether the endpoint is bound, separates its display name and role from the owner+actor wire principal, names the current lifecycle UID, and states whether replacement evidence is known. Values the connector cannot establish are reported as `unknown`; an unavailable predecessor is never presented as the current incarnation.
