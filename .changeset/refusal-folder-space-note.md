---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

A refusal in a project folder whose space is not the selected one now keeps the note under its
`Mesh:` heading that says the selection applies outside the folder. In a folder prepared for its own
space and not started yet, `who`, `send` and `ps` refused under a bare `Mesh: <space>` heading, so
nothing said why the selected space was not the target.
