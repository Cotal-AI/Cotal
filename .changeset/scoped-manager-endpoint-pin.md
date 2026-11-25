---
"@cotal-ai/cli": patch
---

When endpoint describe or invoke refuses an invalid instance ID, keep the Manager lookup on the selected space and broker. For other endpoints, ask for that endpoint's own instance ID.
