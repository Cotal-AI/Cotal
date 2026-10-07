---
"@cotal-ai/lang": patch
---

`validate()` now refuses with L2032 a `parallel`, `race` or `fanOut` branch, or a `once` or `conclave` body, that writes a binding declared outside it through a destructuring target (`[n] = r`, `({ n } = r)`, `[o.a] = r`, nested, default and rest elements included) or through a `for (n of xs)` loop with no declaration. These writes used to validate clean and fail with L2032 only when the branch ran, after any effects dispatched before it.
