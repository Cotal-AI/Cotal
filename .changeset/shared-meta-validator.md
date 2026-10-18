---
"@cotal-ai/core": patch
---

Contract compiles meta-validate through one shared Ajv instance, so the JSON Schema 2020-12 meta-schema compiles once per process instead of once per contract. Each closure still compiles on its own fresh instance, and verdicts and error text are unchanged. A cold compile of the manager's contract table drops from about 950 ms to about 190 ms.
