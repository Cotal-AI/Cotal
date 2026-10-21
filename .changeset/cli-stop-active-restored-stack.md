---
"@cotal-ai/cli": patch
"cotal-ai": patch
---

Allow ordinary shutdown of a legacy stack after its restore has reached the validated active state for the registered space. Keep pending maintenance transitions, mismatched spaces and all existing root, ownership, sharing and native process guards blocked. Shutdown preserves the restore journal and fallback store.
