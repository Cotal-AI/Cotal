---
"@cotal-ai/cli": patch
---

`personas list -v` no longer prints a persona's summary line and then the same line again as the
start of its body. A description that differs from the body's first line is still shown.
