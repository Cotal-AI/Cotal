---
"@cotal-ai/cli": patch
---

Foreground controller stacks now exit with failure when their broker dies so an operating-system supervisor can restart them. Stack and mesh records remain available for repair, while an intentional whole-stack stop still releases the launcher successfully. The supervision guide explains login and boot limits on each platform.
