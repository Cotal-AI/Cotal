---
"cotal-ai": patch
---

Refuse `cotal update --self` before staging when the npm prefix is not writable, instead of reporting a newer version while the installed package stays unchanged.
