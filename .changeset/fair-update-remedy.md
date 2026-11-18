---
"cotal-ai": patch
---

Use an available privilege command in the update remedy for a non-writable npm installation.
Prefer sudo on PATH, otherwise doas, or ask an administrator to run npm as root when neither is available. Reconcile afterwards as the normal user without elevation.
