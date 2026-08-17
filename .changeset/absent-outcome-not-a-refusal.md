---
"@cotal-ai/core": patch
---

A bind refusal that omits `outcome`, or states `unknown`, no longer licenses an automatic
re-issue: only an explicit `not-executed` does. Third-party responders that emit the
bind-refused marker without the outcome field will see their splits surfaced to the caller
rather than repaired, which is what the spec requires, since a refusal raised before dispatch is
required to carry `not-executed` in the first place.
