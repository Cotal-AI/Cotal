---
"@cotal-ai/cli": patch
---

A team manifest whose `persona` names a catalog persona, such as `persona: p20`, is still refused,
but the refusal now says that `persona` takes a path relative to the manifest and names the catalog
persona's path, such as `./.cotal/agents/p20.md`, when the project has one. The manifest docs say
the same.
