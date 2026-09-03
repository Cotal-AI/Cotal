---
"@cotal-ai/cli": patch
---

`cotal status` now names the root behind every persona row, and flags the case where the folder you are standing in is not the one a bare `cotal spawn` will use.

Status could print `personas  default` in green under "This Folder" while `cotal spawn` refused in the same second with "no default persona yet". Both were right about their own root and neither said which root that was: the folder's catalog is `<root>/.cotal/agents`, while spawn loads the resolved mesh's, and the two diverge whenever `cotal use`, a `--space`, or a registry entry points elsewhere. The personas status listed and the personas spawn could launch could be completely disjoint.

When the two roots differ, status now names both, says what the spawn root actually offers, and drops the green from a `default` that will not launch. When they agree, the output stays as short as it was.
