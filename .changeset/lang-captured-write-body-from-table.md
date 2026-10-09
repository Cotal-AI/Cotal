---
"@cotal-ai/lang": patch
---

The static captured-write check (L2032) now reads a scope's body position from the syntax table, as the argument just before the options bag. It used to name `fanOut` and `conclave` as the primitives whose body is the second argument, so a scope primitive added to the table with its body second had its first argument walked and a captured write in its body passed `validate` with no error. The five current scope primitives validate as before.
