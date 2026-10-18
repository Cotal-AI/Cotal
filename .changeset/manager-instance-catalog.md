---
"@cotal-ai/auth": patch
---

The auth service serves `POST /manager-instances`: the signed-in human's own manager instances, read-only, on both faces. It verifies the same IdP proof the human exchange verifies, derives the owner the same way, and lists every manager gate of that owner with the verdict selection reads (`candidate`, `not open`, `not registered`, `unknown`). Selection is now built on the same list, so the two cannot disagree. A record is registration evidence, not proof that the instance answers. Browser-origin requests are refused as on every exchange route, and a failed gate read answers 503, never an empty list.
