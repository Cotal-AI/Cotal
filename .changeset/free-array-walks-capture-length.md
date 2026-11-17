---
"@cotal-ai/lang": patch
---

The workflow language's free `map`, `filter`, `find`, `some` and `every` now read the array's length once, before the first callback call, as their method spellings and JavaScript do. Before this, a callback that appended to the array it walked was called for the appended element, so `map(xs, f)` and `xs.map(f)` gave different results, and a callback that appended on every call ran until the run failed on the interpreter's step bound (L4013).
