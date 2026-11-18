---
"@cotal-ai/cli": patch
---

`cotal service add`, `cotal service` and `cotal manager start` run with `--space` now name that space on the service and manager commands they suggest. The suggested `svc start`, `svc show`, `manager logs` and `manager stop` used to leave it out, so from another folder they acted on the selected space and were refused.
