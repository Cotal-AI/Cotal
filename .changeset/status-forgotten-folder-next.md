---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

`cotal status` in the folder of a forgotten prepared space now names `cotal space create <name> --root <root>` as the next step. It used to name a bare `cotal up`, which started the default space `main` there and then blocked preparing the forgotten space in that folder again.
