---
"@cotal-ai/core": patch
"@cotal-ai/workspace": patch
"@cotal-ai/manager": patch
"cotal-ai": patch
---

Make the first manager identity on a fresh root an exclusive create. Of N concurrent starts, exactly one process mints the instance file and the others adopt that identity or refuse with a named error, so they cannot take two leases.
