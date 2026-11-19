---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

Preserve added extensions and removed connectors when updating after an npm downgrade, and leave newer connector sets untouched when an older CLI refuses reconciliation.
