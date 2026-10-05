---
"@cotal-ai/connector-core": patch
---

Connector processes no longer build the `cotal_docs` bundle and its search index when they start. `cotal_docs` builds the bundle on its first call and the index on its first search, and `DOCS_VERSION` no longer reads the bundle, so the Claude Code hook and extension entry, which never serve the tool, no longer carry the docs at all. Measured on the Claude Code connector with no mesh identity: an idle bridge settles at 88 MiB resident instead of 140 to 143 MiB, and `hook.cjs` shrinks from 3.1 MB to 1.5 MB and peaks at 65 MiB per event instead of 128 to 130 MiB.
