---
"@cotal-ai/manager": patch
"@cotal-ai/cli": patch
---

A manager that fails while it starts now names the cause. Its native child dropped the error and logged only `Code: OPERATION_UNKNOWN`, so `cotal manager start` quoted that line and `cotal service logs manager` showed no reason. The child now writes one last line, `✗ the manager did not start:` with the failure's code and message, the error it wraps and its remedy, and exits 3 as before, so the refusal quotes the cause and the log holds it. A `--foreground` start that exits before readiness no longer says its log records the cause: it says its output went to this terminal and was not captured in its log, and names no log to read.
