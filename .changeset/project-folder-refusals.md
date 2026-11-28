---
"@cotal-ai/cli": patch
---

Keep paths with control or bidirectional formatting characters out of project refusal telemetry. When `space create` cannot inspect its root because access was denied, report a permission error and leave the project untouched.
