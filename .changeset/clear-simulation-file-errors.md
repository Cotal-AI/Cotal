---
"@cotal-ai/runtime": patch
---

Report why a simulation results file cannot be read and accept a leading UTF-8 byte-order mark.
Missing files, directories and permission failures retain their own refusal codes. Empty files and
invalid JSON name the results path and a next step.
