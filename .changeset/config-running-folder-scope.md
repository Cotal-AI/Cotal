---
"@cotal-ai/cli": patch
"cotal-ai": patch
---

Make `cotal config` read the space a launch in the current folder uses when another space is selected. Write receipts and missing-persona warnings use the same space, while explicit `--space` and `--user` reads keep their scopes.
