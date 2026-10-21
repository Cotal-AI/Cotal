---
"@cotal-ai/core": patch
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

Process records never write through a symlink. `@cotal-ai/core` adds `writePrivateRecord` and `createPrivateRecord`, which take `writeSecretFile`'s private open without its Windows ACL step. The manager's delivery-aware marker and a pid identity pin are rewritten with `writePrivateRecord`, so a symlink at either name is refused with `EPERM` and left unchanged. The pid, pin and bridge temporaries `writePidPair` publishes are created with `createPrivateRecord`, exclusively and owner-private, and only the temporaries a call created are removed afterwards.
