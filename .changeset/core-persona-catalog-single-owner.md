---
"@cotal-ai/core": patch
"@cotal-ai/cli": patch
---

List the persona catalog in one place, `@cotal-ai/core`'s `listPersonaCatalog` and `readPersonaCatalog` (`PersonaCatalogEntry`), and call them from `cotal persona`, `cotal personas`, `cotal status` and the CLI completion helpers in place of the CLI's separate `listPersonas`, `readPersonas` and `PersonaEntry` copy.
