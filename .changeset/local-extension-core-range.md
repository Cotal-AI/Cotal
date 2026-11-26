---
"@cotal-ai/cli": patch
"cotal-ai": patch
---

`cotal ext add` refuses a local or third-party extension whose declared core peer range does not match the bundled core, without changing the installed extensions.
