---
"@cotal-ai/manager": patch
---

The manager service-ops smoke's M6 manifest entry now opts out of the event plane, as every other spawn in that suite does. The stub connector publishes no event plane, and that refusal runs before the hard-pinned name check, so the cell got the event-plane refusal instead of the manifest-declared collision refusal it grades. The suite is green again.
