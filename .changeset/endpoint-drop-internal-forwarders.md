---
"@cotal-ai/core": patch
---

Drop the endpoint's private forwarders that only other internal components called; those components now reach the owning component directly. The package's exports are unchanged.
