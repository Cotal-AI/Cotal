---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

Stop a local stack safely after its Cotal home records are lost.
The project journal retains launch-time host and process creation pins for a guarded Linux recovery stop, and missing-record diagnostics no longer assume another home holds the records.
