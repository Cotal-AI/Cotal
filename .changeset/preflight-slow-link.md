---
"@cotal-ai/core": patch
"@cotal-ai/workspace": patch
"cotal-ai": patch
---

Preflight reports a probe that ran out of its budget as a slow link instead of a trust failure: `probeConnect` now returns a distinct `timeout` reason, `preflightTarget` routes it to a new `slow-link` verdict without consulting the INFO greeting, and the rendered sentence names the connect budget and says the registry entry was kept, never a CA. A real certificate failure against a TLS-required mesh still renders the `tls-trust` guidance.
