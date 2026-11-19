---
"cotal-ai": patch
"@cotal-ai/cli": patch
---

Linux updates can reach the recorded daemon service from a non-login shell without `XDG_RUNTIME_DIR`. Both update modes use the same private, effective-user-owned runtime directory that daemon commands use.
