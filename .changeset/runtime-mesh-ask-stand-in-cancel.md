---
"@cotal-ai/runtime": patch
---

The mesh-ask smoke's manager stand-in now serves the reserved `cancel`, committing the relay's goal `cancelled` as the manager does, so a cancelled ask and the discharge withdraw their relay instead of failing on a command the stand-in never described. Cell 7 passes again and the suite runs cells 8 to 11 and its summary. Cell 11's resumed escalation now records its attempt index on its binding, as every checkpoint binding has since each attempt began binding its own deadline.
