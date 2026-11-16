---
"@cotal-ai/core": minor
---

Correct contract validation for admitted JSON Schema 2020-12 references and evaluated annotations.

Instance validation now uses json-schema-library 11.6.16, while Ajv retains schema meta-validation.
The synchronous validator exposes backend-neutral errors instead of Ajv metadata. Generated browser
contract modules import the shared interpreter and must be regenerated with this release.
