---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

Service option refusals and preset help now show accepted numeric bounds, including 0 through 65535 for the manager console port. Both read the bounds from the adapter schema, and refusals do not print the submitted value.
