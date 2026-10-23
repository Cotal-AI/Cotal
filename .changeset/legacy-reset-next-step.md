---
"@cotal-ai/cli": patch
---

On a running legacy root, the `reset store` and `reset space` verdicts now name `cotal down` and then
`cotal clean store --force` or `cotal clean all --force` from that root. Before, they named the reset
again after `down`, which refuses because a legacy `down` drops the registration a reset selects.
