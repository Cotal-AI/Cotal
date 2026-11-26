---
"@cotal-ai/connector-core": patch
"@cotal-ai/cli": patch
"cotal-ai": patch
---

`cotal ext add` refuses an extension whose declared core peer range does not match the bundled core, without changing the installed extensions.
