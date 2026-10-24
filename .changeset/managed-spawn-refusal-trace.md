---
"@cotal-ai/cli": patch
"@cotal-ai/manager": patch
---

A managed `spawn` prints its `Managed launch` plan on stdout with its receipt, so
`cotal spawn <persona> -d > out.txt` keeps it, and a refusal is on stderr. With `--json` the
plan stays on stderr. The manager that refuses a spawn now writes one line to its log with the
original request ID, the persona and the reason, so `cotal service logs` on its host finds a refused
launch after the terminal is gone.
