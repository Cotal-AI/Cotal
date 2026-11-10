---
"cotal-ai": patch
---

Daemon service connections now report when a space's account differs from the pinned identity.

`service-connect` and `service-status` preserve the `ACCOUNT_MISMATCH` diagnosis and recovery guidance instead of reporting a generic registration conflict. The daemon leaves its identity and registration request unchanged.
