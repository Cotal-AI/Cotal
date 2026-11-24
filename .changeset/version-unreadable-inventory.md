---
"cotal-ai": patch
"@cotal-ai/cli": patch
---

The version command and its aliases still print the running CLI version when the extension manifest is unreadable. Text output reports the inventory problem and repair step on stderr, and exits 4 as JSON output does.
