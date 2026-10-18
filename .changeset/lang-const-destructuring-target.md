---
"@cotal-ai/lang": patch
---

`validate()` and `transform()` now refuse a write to a `const` binding through a destructuring assignment (`[c] = [1]`, `({ c } = { c: 1 })`) or a `for...of` with no declaration (`for (c of xs)`) with L2003. These used to validate clean and fail with L2003 only when the line ran, after any effects dispatched before it.
