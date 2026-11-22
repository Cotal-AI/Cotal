---
"cotal-ai": patch
"@cotal-ai/cli": patch
---

`cotal setup` no longer fails the selected harness when another installed harness cannot refresh its optional Cotal skills. Setup finishes, refreshes the remaining harnesses, and reports the one it skipped as a warning.
