---
"@cotal-ai/cli": patch
---

Keep local paths out of telemetry when a command refuses a control directory as its project or a checkout tries to write the connector store. Project retries identify which folder option to change without dropping other options.
