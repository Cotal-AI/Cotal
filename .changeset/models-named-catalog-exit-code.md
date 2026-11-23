---
"cotal-ai": patch
---

The models reference now distinguishes a named catalog read from an all-catalog read: naming the one unreadable catalog with `--harness` fails with exit 5, while an all-catalog read with unreadable rows stays partial with exit 4.
