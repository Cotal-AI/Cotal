---
"@cotal-ai/cli": patch
---

When a preset file is missing, show how to inspect the intended space and retry with that space’s file. Keep the local path out of telemetry. When a preset lacks a broker address, keep the retry on the original command instead of suggesting a startup in the current folder.
