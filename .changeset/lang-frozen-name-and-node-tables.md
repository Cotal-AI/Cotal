---
"@cotal-ai/lang": minor
---

`ADMITTED_NODES`, `STRUCTURAL_NODES`, `RESERVED_NAMES`, `FORBIDDEN_GLOBALS` and `MUTATING_METHODS` are now frozen arrays, and `CATALOG` is frozen. They were `Set` objects typed `ReadonlySet`, which `Object.freeze` cannot protect, so a caller's `add` or `delete` changed what `validate` accepts for the rest of the process, and a write to `CATALOG` retitled every later error with that code. The validator now keeps its own Sets, and a write to any of these tables throws. Code that calls `.has` or reads `.size` on one of them should use `.includes` and `.length`.
