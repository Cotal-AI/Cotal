---
"@cotal-ai/core": patch
"@cotal-ai/workspace": patch
"cotal-ai": patch
---

Failed preference and prepared-space writes now clean up their temporary files.
Exclusive private-record writes also remove a newly created partial file on failure without
removing a file that already belonged to another writer.
