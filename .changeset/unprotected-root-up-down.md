---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

`cotal up` now refuses a project root that other local accounts can write, with the same check `space create` applies, before it writes anything. In a group-writable folder on a host without a private-group proof, such as one whose `/etc/nsswitch.conf` names `sss`, `space create` refused but `up` started a legacy `main` stack, and bare `down` then refused "the additive attempt inventory could not be read" with no cause and no next step. The refusal from every command that checks a path now names every unsafe entry in its chain at once, with one remedy such as `chmod g-w <project> <parent>`. Bare `down` and `status` also name that cause for a stack an earlier release started there.
