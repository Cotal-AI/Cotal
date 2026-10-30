---
"@cotal-ai/lang": patch
---

Keep foreign error names and messages consistent across worker execution, inspection and the host bridge. Shared readers retain only string-valued fields and contain throwing accessors or failed string conversion, so formatting a failure does not strand its answer.
