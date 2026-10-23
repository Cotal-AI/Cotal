---
"@cotal-ai/cli": patch
---

`cotal config set persona <name>` now warns `PERSONA_NOT_FOUND`, naming the catalog, when the catalog of the space a command there uses does not hold that persona or file. The value is still saved, since the file may be created later. A name that breaks the persona name rule is still refused.
