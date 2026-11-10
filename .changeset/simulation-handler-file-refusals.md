---
"@cotal-ai/runtime": patch
---

Simulation results files now report their path, cause and next step when they cannot be read or parsed, and accept a leading UTF-8 byte-order mark.

The results-file reader shares the program reader's regular-file checks and keeps rejecting invalid UTF-8 before simulation.
