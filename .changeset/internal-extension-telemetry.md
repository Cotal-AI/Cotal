---
"@cotal-ai/cli": patch
---

Keep internal extension update helpers out of CLI telemetry so they do not create install IDs or send package diagnostics. Public extension commands still report normally.
