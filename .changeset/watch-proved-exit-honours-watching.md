---
"@cotal-ai/manager": patch
---

A streaming seat's exit watch now stops calling its callback once the caller has stopped watching, the same way a seat with no exit stream already did. A restart that has swapped the seat's handle no longer needs its own check to keep the old child's late exit from retiring the new one.
