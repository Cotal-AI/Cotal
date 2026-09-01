---
"@cotal-ai/lang": minor
"@cotal-ai/connector-core": minor
---

cotal-lang DX: the conformance corpus and the language card. Every js block in the language reference is generated into a JSON artifact shipped inside @cotal-ai/lang (conformance/corpus.json) with the verdict the validator gives it, served by a new conformanceCorpus() accessor, so a second implementation can run the same claims from the file alone; pnpm gen:conformance regenerates it and smoke:lang-conformance holds the shipped bytes identical to a fresh build from the reference. docs/lang-card.md is a one-page card of the language (effects and their results, the await rule, branch keys, top refusals), validated block by block like the reference itself and carried in the connector docs bundle.
