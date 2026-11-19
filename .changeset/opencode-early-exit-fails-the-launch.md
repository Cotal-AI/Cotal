---
"@cotal-ai/connector-opencode": patch
---

`cotal spawn --harness opencode` now exits non-zero when the OpenCode server stops on its own before its Cotal session is ready, even when OpenCode itself exits 0. It used to forward that 0 and report success for a seat that never joined. A server that exits with an error keeps its own status, and the boot-log message is unchanged.
