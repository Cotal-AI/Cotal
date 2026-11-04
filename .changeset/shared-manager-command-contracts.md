---
"@cotal-ai/core": patch
"@cotal-ai/manager": patch
---

Runtime integration tests now use the manager's actual command schemas.

Share the spawn, stop, inspect and cancel schemas from core beside the turn contracts, preserving the manager's served contract digests. Runtime stand-ins no longer accept blank spawn fields that the manager refuses. The shared schema objects are deeply frozen so importing a schema cannot change the manager's validation.
