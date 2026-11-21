---
"@cotal-ai/cli": patch
---

Saved endpoint inventory now names an unknown space and shows how to find a valid name and retry. JSON refusals include the requested name in `target.requested`. The diagnostic stays local, and regular telemetry reports the refusal code without its message or stack.

Regular telemetry also strips values attached to short flags, including grouped flags.
