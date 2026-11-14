---
"@cotal-ai/delivery": patch
"@cotal-ai/manager": patch
---

Make strict package-manager installations load all required runtime dependencies.

Declare the delivery transport and Manager console codec as production dependencies. Check every published package's built JavaScript for undeclared runtime imports in the existing dependency census.
