---
"@cotal-ai/cli": patch
"cotal-ai": patch
---

When self-update restores write access to an installation directory and then cannot reach the registry, report that no installed packages were replaced. Keep the existing exit status.
