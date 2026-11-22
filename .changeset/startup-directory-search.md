---
"@cotal-ai/cli": patch
---

When `cotal up` refuses because the project directory or `.cotal` lacks write or search access, it suggests `chmod u+wx` to restore both permissions.
