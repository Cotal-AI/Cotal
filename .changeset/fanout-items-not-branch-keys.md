---
"@cotal-ai/lang": patch
---

`run validate` no longer refuses a `fanOut` with L3025 when a property name in an items object
literal holds `/`, `#` or `:`. The static rule read those names as branch keys. A `fanOut` mints its
branch keys at run time from `key` or each item's `id`, and the run still refuses one that holds a
reserved character with L3025. The static rule keeps covering `parallel` and `race` record keys.
