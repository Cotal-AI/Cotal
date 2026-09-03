---
"@cotal-ai/lang": minor
"@cotal-ai/connector-core": minor
---

cotal-lang DX: the conformance corpus and the language card. Every js block in the language reference is generated into a JSON artifact shipped inside @cotal-ai/lang (conformance/corpus.json) with the verdict the validator gives it, served by a new conformanceCorpus() accessor, so a second implementation can run the same claims from the file alone; pnpm gen:conformance regenerates it and smoke:lang-conformance holds the shipped bytes identical to a fresh build from the reference. The artifact states its own adjudication rule, so a reader holding only the JSON knows a refusal is checked by membership in the validator's answered codes, never by equality with a single code. docs/lang-card.md is a one-page card of the language (effects and their results, the await rule, branch keys, top refusals), validated block by block like the reference itself, carried in the connector docs bundle, and published on the docs site beside the other reference pages.
