---
"@cotal-ai/connector-jcode": patch
---

Verify the active Jcode model and provider route before applying `--variant`. A route that accepts
reasoning effort still receives the requested tier before its first turn. A route without that
capability now fails with an explicit unsupported-capability diagnostic instead of a tier refusal.
