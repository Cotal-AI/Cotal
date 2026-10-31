---
"@cotal-ai/connector-core": minor
"@cotal-ai/connector-claude-code": minor
"@cotal-ai/connector-codex": minor
"@cotal-ai/connector-hermes": minor
"@cotal-ai/connector-jcode": minor
"@cotal-ai/connector-opencode": minor
"@cotal-ai/pi": minor
---
Precompute documentation search at build time and load the corpus and compact index only when needed. Search results and scoring are unchanged. Documentation data now lives in two digest-checked files beside each module or bundle; normal packages, plugins and installers include them automatically. Custom integrations that copy or bundle an executable alone must also carry its matching `docs-bundle.bin` and `docs-index.bin` files.
