---
"@cotal-ai/core": patch
---

Add a Linux private-file take boundary for environment-manager bootstrap material. Pin the private parent directory, consume the file before returning bounded UTF-8 bytes, and refuse unsafe owners, permissions, aliases and file types. This does not add a runnable manager bootstrap or CLI consumer.
