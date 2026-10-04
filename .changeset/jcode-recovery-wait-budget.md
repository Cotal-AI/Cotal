---
"@cotal-ai/connector-jcode": patch
---

The provider-disconnect and permanent-refusal smokes now give each bridge-recovery step the host's own 60 second recovery window, read from the host source instead of copied. They used to allow 20 seconds per step, so a loaded CI runner could red the first replacement attach while the host was still inside its window. Host behaviour is unchanged.
