---
"@cotal-ai/cli": patch
---

`--store-dir` refuses an empty value `USAGE_INVALID` instead of reading it as the default store, and
refuses a value that starts with a `~` no shell expanded instead of making a folder named `~`; that
refusal names the absolute path to pass. A store in the project folder itself, as `up --store-dir .`
makes, still refuses `clean store` and `reset store`, now `CONFLICT` with a Next that names the
store's own entries to remove by hand.
