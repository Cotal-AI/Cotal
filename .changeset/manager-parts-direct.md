---
"@cotal-ai/manager": patch
---

Manager parts now call the parts that own these operations directly, through the Manager's parts record, instead of through a Manager method that only forwarded the call. Exports, commands and wire behaviour are unchanged.
