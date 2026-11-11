---
"cotal-ai": patch
---

Retry native daemon ownership checks before restart and uninstall when startup could not verify ownership. Distinguish missing provenance from an unknown observation, keep checks bounded and cache only verified ownership.
