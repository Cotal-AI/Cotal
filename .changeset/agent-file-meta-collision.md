---
"@cotal-ai/core": patch
---

`saveAgentFile` now refuses a `meta` key that names a modeled frontmatter field (such as `name`, `model`, `owner` or `capabilities`) or a renamed one (`channels`, `publish`) before it creates a directory or writes the file. Metadata used to overwrite the fields it had just validated. Unknown scalar connector hints still round-trip unchanged.
