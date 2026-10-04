---
"@cotal-ai/manager": patch
---

A `cotal supervise --roster` entry now takes a `share-tools:` list that narrows the operator's declared MCP servers for that agent, the same selection `spawn --share-tools` makes: an absent key keeps every declared server, `[]` shares none, and an undeclared name fails that entry. Before this the roster loader dropped the key, so every rostered agent launched with the full pool. A value that is not a list, or a name the flag cannot carry unchanged such as `none` alone or one with a comma or surrounding spaces, fails the roster load.
