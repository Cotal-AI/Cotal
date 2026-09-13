---
---

Close the class of textual gradability witnesses in mutation-coverage. A suite that only mentions a path, spawn token, or `../src/` string no longer counts as covering a mutation. Coverage now requires an AST load, spawn, or copy that actually reaches the mutated file.

Refs #1434
