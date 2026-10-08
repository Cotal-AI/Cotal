---
"@cotal-ai/lang": patch
---

`PRIMITIVES`, `EVENT_CONSTRUCTORS`, `PURE_PRIMITIVES` and `FORBIDDEN_NODES` are now frozen through every row and nested array. A write to a row, or to the `callee` a validation `LangError` carries, throws instead of changing what `validate` accepts or reports for the rest of the process.
