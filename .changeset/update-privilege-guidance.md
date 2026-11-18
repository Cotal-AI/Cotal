---
"cotal-ai": patch
---

Self-update refusals now suggest the privilege tool available on your PATH.
For an unwritable system installation, the administrator command uses sudo when available,
otherwise doas, or asks for a root shell when neither is available. Reconciliation remains
under your normal account, and the updater never runs either privilege tool.
