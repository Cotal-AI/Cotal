---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

A refusal of a mesh target now names the space and root it concerns under `target` in `--json`, where they are known. A stopped space's `ps`, `who`, `whoami`, `endpoints` and `history` refusals carried `"target": null` although the message named the space, so a script had to parse the message to tell which space refused.
