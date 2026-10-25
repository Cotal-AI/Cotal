---
"@cotal-ai/workspace": patch
"@cotal-ai/connector-core": patch
---

An operator command whose target is the selected space, or the space registered at its project's root, no
longer probes every other recorded broker before it connects. An unrelated registration whose broker
does not answer slowed `send`, `history`, `who`, `ps` and the other commands in the selected space by
several seconds. A command that picks among the running meshes still probes them once.
