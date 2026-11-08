---
"@cotal-ai/manager": patch
---

A default manager stop retires a managed seat whose handle cannot release custody, instead of dropping it and leaving its lifecycle and grant with no successor.
