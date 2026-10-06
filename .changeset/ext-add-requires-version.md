---
"@cotal-ai/cli": patch
---

`cotal ext add` refuses a package whose `package.json` declares no `version`, or an empty one, and rolls the add back. It used to record such a package as `0.0.0` (or with an empty version), and every later load then reported it as in the manifest but not installed, which a re-add repeated.
