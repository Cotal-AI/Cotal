---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
"@cotal-ai/manager": patch
---

A missing `--yes` outside an interactive terminal now refuses in two lines, the refusal and a
remedy that names `--yes`, as `down` does. `history clear`, `persona remove`, `channel remove`,
`space delete`, `reset store`, `reset space`, the service and team removals, and the other
confirmed commands printed the whole command help after the refusal, and several gave no remedy.
