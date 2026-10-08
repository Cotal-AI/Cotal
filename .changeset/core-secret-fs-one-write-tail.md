---
"@cotal-ai/core": patch
---

`writeSecretFile` and the create-only secret write now share one private write path, so the Windows rule that removes a file whose ACL could not be hardened lives in one place. The reason the create-only path checks the name with `lstatSync` on Windows is now written once, in its doc comment. No runtime change.
