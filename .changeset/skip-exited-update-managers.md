---
"@cotal-ai/cli": patch
---

On Linux, `cotal update --self` skips Managers that exit during the launch-coordinate check and still refuses when a running Manager's coordinates cannot be read.
