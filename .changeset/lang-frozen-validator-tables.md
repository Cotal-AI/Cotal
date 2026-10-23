---
"@cotal-ai/lang": minor
---

`ADMITTED_NODES`, `STRUCTURAL_NODES`, `RESERVED_NAMES`, `FORBIDDEN_GLOBALS` and `MUTATING_METHODS` are now exported as frozen arrays instead of `Set`s, and `CATALOG` is frozen. Code that imports the package could call `add` or `delete` on one of those sets, or assign a `CATALOG` title, and change what `validate` accepted or how its errors were titled for the rest of the process. The tables can no longer be changed: a write throws in strict-mode code, such as an ES module, and changes nothing elsewhere. This changes the exported type, so a caller that used `.has` or `.size` on one of these tables uses `.includes` or `.length` instead.
