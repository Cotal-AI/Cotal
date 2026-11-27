---
"@cotal-ai/core": patch
"@cotal-ai/cli": patch
"cotal-ai": patch
---

Flags written after `--` stay flags, so `cotal persona create -- reviewer --prompt '...' --subscribe=` saves the persona instead of refusing the command's own separator guidance.
