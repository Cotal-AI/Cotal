---
"@cotal-ai/cli": patch
"cotal-ai": patch
---

Linux daemon installation now accepts home and config directories containing spaces.
Decode systemd's quoted environment values without evaluating shell text, while retaining directory validation and refusal of malformed values.
