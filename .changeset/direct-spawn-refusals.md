---
"@cotal-ai/cli": patch
---

A `cotal spawn` in this terminal now checks its persona and connector before it prints that it is starting the application. A missing persona is refused with `TARGET_NOT_FOUND` and a missing connector with `DEPENDENCY_UNAVAILABLE`, each with its code, Next and exit 2. Before, the banner came first and the refusal was one line with exit 1.
