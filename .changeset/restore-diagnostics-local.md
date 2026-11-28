---
"@cotal-ai/cli": patch
---

Keep the retained store path and restored broker details out of command telemetry when cleanup refuses to discard history or startup finds the restored broker still running. Keep rejected restore target paths and names of files that block restore or cleanup local too. Local diagnostics and recovery instructions stay unchanged.
