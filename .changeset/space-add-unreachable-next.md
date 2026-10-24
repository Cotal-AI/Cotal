---
"@cotal-ai/cli": patch
---

`cotal space add` refused for a broker that does not answer now gives a next step: pass `--force` to add the space unchecked, as for a space that is down right now. It used to carry no next step.
