---
"@cotal-ai/cli": patch
---

`backup create` now refuses `USAGE_INVALID` (exit 1) a destination inside a path `cotal clean all`
removes, such as `.cotal/auth` or the space's `.cotal/space.<hex>` folder, and writes nothing.
Before, it published the backup there, and the next `clean all --force` removed it with the space's
identity.
