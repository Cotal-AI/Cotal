---
"@cotal-ai/connector-core": patch
---

The version-exact docs bundle `cotal_docs` serves is generated during the connector's build instead of being committed. Any two branches that regenerated the same region of the checked-in artifact conflicted in it while their source pages merged cleanly, so editing a docs page now means editing the page and nothing else. `check:docsbundle` can no longer diff a committed file, so it regenerates into a temporary path and refuses a generator failure or a hollow bundle, which keeps a release unable to ship empty docs; the upgrade-section gate regenerates the same way instead of reading the tree behind an `existsSync` that silently dropped its shipped-copy check when the file was absent. Fixes #1713.
